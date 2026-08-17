import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locations, notifications, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSessions, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * POST /api/casino/act — wagerDelta, settle, payout.
 *
 * Runs against the real installed `blackjack` game through a bare
 * `bootTestServer()`, exactly `casino-play.test.ts`'s shape.
 *
 * Every hand here is seeded DIRECTLY into `p_casino_sessions` with a
 * hand-built `BlackjackState` rather than opened through `play` + a real
 * shuffle: `play`'s own test file already proves escrow against the real
 * shoe, and a real shuffle cannot deterministically produce "player hits
 * then stands for a loss" vs. "a natural" vs. "double bankrupts the house"
 * on demand. Seeding is exactly the idiom `casino-play.test.ts`'s "refuses a
 * second play while one is open" test already uses for the same reason.
 *
 * Money bookkeeping: seeding a session is standing in for a `play` call that
 * already happened, so each test sets the player's and (if any) owner's cash
 * to reflect the wager already having been escrowed — the same shape
 * `escrow()` itself leaves behind. `act`'s own money movements (a
 * `wagerDelta` escrow, and `settleSession`'s payout) are what's under test.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  const username = `Dealer${regCounter}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.61.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ token: string; playerId: string }>();
}

async function seedLocation(): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id,
    name: `city-${id.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  return id;
}

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

/** Sum of every ledger row for `id`, cash kind — same reduce-in-JS idiom
 *  `economy-invariant.test.ts` uses, rather than a raw SQL aggregate. */
const ledgerSumOf = async (id: string): Promise<bigint> => {
  const rows = await db.select({ amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.playerId, id));
  return rows.reduce((sum, r) => sum + r.amount, 0n);
};

/** Same shape `seedHouse` in `casino-play.test.ts` uses. `cost` is the
 *  owner's lever (0n means "unset", falling back to the `max_bet` setting). */
async function seedHouse(locationId: string, ownerId: string, cost: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId, pluginId: "blackjack", ownerPlayerId: ownerId, cost, profit: 0n,
  });
  return id;
}

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats).set({ locationId, cash }).where(eq(playerStats.playerId, playerId));
}

/** `state.ts`'s tagged-bigint wire shape, reproduced here rather than
 *  imported: the casino package exports only its manifest, and widening its
 *  public surface just for a test fixture isn't worth it (the same call the
 *  `plugin-tables.ts` header explains for the DDL mirrors). */
const bi = (n: bigint): unknown => ({ __casino_bigint__: n.toString() });

interface Seeded {
  sessionId: string;
}

/** Inserts an open (or, for test 6, already-settled) session with a
 *  hand-built `BlackjackState` so hit/stand/double outcomes are exact. */
async function seedSession(opts: {
  playerId: string;
  locationId: string;
  propertyId: string | null;
  wager: bigint;
  player: string[];
  dealer: string[];
  cursor: number;
  shoe: string[];
  status?: "open" | "settled";
  createdAt?: Date;
}): Promise<Seeded> {
  const sessionId = uuidv7();
  await db.insert(casinoSessions).values({
    id: sessionId,
    ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
    playerId: opts.playerId,
    gameId: "blackjack",
    locationId: opts.locationId,
    propertyId: opts.propertyId,
    wager: opts.wager,
    state: {
      shoe: opts.shoe,
      cursor: opts.cursor,
      player: opts.player,
      dealer: opts.dealer,
      wager: bi(opts.wager),
      phase: "player",
    },
    status: opts.status ?? "open",
    seed: "fixture",
  });
  return { sessionId };
}

function act(token: string, action: string) {
  return app.inject({
    method: "POST",
    url: "/api/casino/act",
    headers: { authorization: `Bearer ${token}` },
    payload: { action },
  });
}

/**
 * Every card code a response's `view` puts on screen.
 *
 * Walks the JSON the route actually sent rather than the `ViewNode` the game
 * built, because the point of the assertion below is what reaches the PLAYER:
 * a code that never crosses this boundary cannot be read out of the payload,
 * whatever the session row holds. `unknown` + narrowing, never a cast.
 */
function cardsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(cardsIn);
  if (node === null || typeof node !== "object") return [];
  const obj: Record<string, unknown> = { ...node };
  if (obj["kind"] === "cards" && Array.isArray(obj["cards"])) {
    return obj["cards"].filter((c): c is string => typeof c === "string");
  }
  return Object.values(obj).flatMap(cardsIn);
}

async function sessionRow(sessionId: string) {
  const [row] = await db.select().from(casinoSessions).where(eq(casinoSessions.id, sessionId));
  return row;
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("POST /api/casino/act", () => {
  it("hits then stands: settles, and the player's net across the hand equals payout - wager", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);
    await placePlayer(playerId, locationId, 1_000_000n);

    const wager = 10_000n;
    // Escrow already happened at (a hypothetical) `play`: player is down the
    // wager, owner is up it.
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    // player 5 (H2+H3), dealer 16 (H10+H6) — dealer must draw on stand.
    const { sessionId } = await seedSession({
      playerId, locationId, propertyId, wager,
      player: ["H2", "H3"], dealer: ["H10", "H6"], cursor: 0, shoe: ["H4", "D9"],
    });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const hitRes = await act(token, "hit");
    expect(hitRes.statusCode).toBe(200);
    const hitBody = hitRes.json<{ done: boolean; wager: string }>();
    expect(hitBody.done).toBe(false);
    // The unfinished branch reports the wager too — an act that does not raise
    // it still has to say what it is, or the page needs a "no figure this
    // time" branch that can never be exercised.
    expect(hitBody.wager).toBe(wager.toString());
    // player now 9 (H2+H3+H4) — no money moves on a non-settling act.
    expect(await cashOf(playerId)).toBe(cashBefore);

    const standRes = await act(token, "stand");
    expect(standRes.statusCode).toBe(200);
    const standBody = standRes.json<{ done: boolean; payout: string }>();
    expect(standBody.done).toBe(true);
    // Dealer draws D9 on 16 -> 25, bust: player wins double.
    const payout = BigInt(standBody.payout);
    expect(payout).toBe(wager * 2n);

    expect(await cashOf(playerId)).toBe(cashBefore + payout);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - payout);

    const row = await sessionRow(sessionId);
    expect(row?.status).toBe("settled");
    expect(row?.settledAt).not.toBeNull();
  });

  it("never sends the dealer's hole card to a player who is still choosing", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    // Dealer H10 up, H6 in the hole. Seeing H6 means seeing that the dealer
    // is on 16 and must draw — the single most valuable fact at the table.
    await seedSession({
      playerId, locationId, propertyId: null, wager: 10_000n,
      player: ["H2", "H3"], dealer: ["H10", "H6"], cursor: 0, shoe: ["H4", "D9"],
    });

    const hit = await act(token, "hit");
    expect(hit.statusCode).toBe(200);
    const body = hit.json<{ done: boolean; view: unknown }>();
    expect(body.done).toBe(false);

    const cards = cardsIn(body.view);
    expect(cards).toContain("H10");                                  // the up-card
    expect(cards).not.toContain("H6");                               // the hole card
    expect(cards.filter((c) => c === "B1" || c === "B2")).toHaveLength(1);
    // Nor through the total: 16 is what H10+H6 makes.
    expect(JSON.stringify(body.view)).not.toContain("\"16\"");

    // And it is revealed the moment the hand is over.
    const stand = await act(token, "stand");
    expect(stand.statusCode).toBe(200);
    const final = stand.json<{ done: boolean; view: unknown }>();
    expect(final.done).toBe(true);
    expect(cardsIn(final.view)).toContain("H6");
  });

  it("a push returns exactly the wager (net zero for both sides)", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    // Both 19 already, dealer >= 17 so `stand` settles with no draw needed.
    await seedSession({
      playerId, locationId, propertyId, wager,
      player: ["H10", "H9"], dealer: ["H9", "H10"], cursor: 0, shoe: [],
    });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ done: boolean; payout: string }>();
    expect(body.done).toBe(true);
    expect(BigInt(body.payout)).toBe(wager);

    expect(await cashOf(playerId)).toBe(cashBefore + wager);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - wager);
  });

  it("a natural pays 2.5x and the house is debited 2.5x", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    // Player 21 on two cards (natural). Dealer 5, must draw twice to bust —
    // isNatural(dealer) is false regardless (its final hand is > 2 cards).
    await seedSession({
      playerId, locationId, propertyId, wager,
      player: ["Ha", "Hk"], dealer: ["H2", "H3"], cursor: 0, shoe: ["H9", "H9"],
    });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);
    const ledgerBefore = await ledgerSumOf(playerId);
    const ownerLedgerBefore = await ledgerSumOf(ownerId);

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ done: boolean; payout: string }>();
    const payout = BigInt(body.payout);
    expect(payout).toBe((wager * 5n) / 2n); // 2.5x

    expect(await cashOf(playerId)).toBe(cashBefore + payout);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - payout);

    // Ledger tracks the movement exactly — sum(ledger) == balance (rule 3),
    // checked as a delta since setup used direct cash sets.
    expect((await ledgerSumOf(playerId)) - ledgerBefore).toBe(payout);
    expect((await ledgerSumOf(ownerId)) - ownerLedgerBefore).toBe(-payout);
  });

  it("double debits a second wager AND credits the house before the hand resolves", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    // Player 9 on two cards (double-eligible). Dealer 16, draws once to 25
    // (bust) on the double's own dealer-play.
    const { sessionId } = await seedSession({
      playerId, locationId, propertyId, wager,
      player: ["H4", "H5"], dealer: ["H10", "H6"], cursor: 0, shoe: ["H2", "D9"],
    });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const res = await act(token, "double");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ done: boolean; wager: string; payout: string }>();
    expect(body.done).toBe(true);

    const newWager = wager * 2n; // 20,000
    // The RAISED wager, reported back. This response is the only place the
    // caller can learn it: the hand settles in the same call, so the session
    // row is `settled` before any lobby read could see the new figure, and a
    // client that assumed its own opening stake would show half the truth.
    expect(body.wager).toBe(newWager.toString());
    const payout = BigInt(body.payout);
    expect(payout).toBe(newWager * 2n); // dealer bust, double win on the new wager

    // Net = -(the extra wager) + payout.
    const net = payout - wager;
    expect(await cashOf(playerId)).toBe(cashBefore + net);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - net);

    const row = await sessionRow(sessionId);
    expect(row?.status).toBe("settled");
    expect(row?.wager).toBe(newWager);
  });

  it("double when the house can no longer cover: 409, session stays open and unchanged", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    // 20,000 (doubled) x 2.5 = 50,000 exposure > the owner's 40,000 cash.
    await placePlayer(ownerId, locationId, 40_000n);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    const preState = {
      shoe: ["H2", "D9"], cursor: 0, player: ["H4", "H5"], dealer: ["H10", "H6"],
      wager: bi(wager), phase: "player",
    };
    const { sessionId } = await seedSession({
      playerId, locationId, propertyId, wager,
      player: ["H4", "H5"], dealer: ["H10", "H6"], cursor: 0, shoe: ["H2", "D9"],
    });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const res = await act(token, "double");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("house_cannot_cover");

    // Nothing moved, and the session is exactly as it was.
    expect(await cashOf(playerId)).toBe(cashBefore);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore);

    const row = await sessionRow(sessionId);
    expect(row?.status).toBe("open");
    expect(row?.wager).toBe(wager);
    expect(row?.state).toEqual(preState);
  });

  it("acting on a settled session: 409 session_closed", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    await seedSession({
      playerId, locationId, propertyId: null, wager: 10_000n,
      player: ["H10", "H9"], dealer: ["H9", "H10"], cursor: 0, shoe: [],
      status: "settled",
    });

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("session_closed");
  });

  it("pays a winner in an UNOWNED town — the faucet leg, with no house to debit", async () => {
    // Spec §4.3 specifies both legs of an unowned town and §10 asked for both;
    // every other test here seeds a house, so `settleSession` had never once
    // run with `propertyId === null` and a payout to make.
    const { token, playerId } = await register();
    const locationId = await seedLocation();

    const wager = 10_000n;
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    // Both 19: `stand` settles as a push with no draw, so the payout is exact
    // without depending on a shoe.
    const { sessionId } = await seedSession({
      playerId, locationId, propertyId: null, wager,
      player: ["H10", "H9"], dealer: ["H9", "H10"], cursor: 0, shoe: [],
    });

    const cashBefore = await cashOf(playerId);
    const ledgerBefore = await ledgerSumOf(playerId);

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(200);
    expect(BigInt(res.json<{ payout: string }>().payout)).toBe(wager);

    // The money comes from nowhere — that is what a faucet is — but it is
    // still a ledger row, so sum(ledger) == balance holds (rule 3).
    expect(await cashOf(playerId)).toBe(cashBefore + wager);
    expect((await ledgerSumOf(playerId)) - ledgerBefore).toBe(wager);

    const row = await sessionRow(sessionId);
    expect(row?.status).toBe("settled");
    expect(row?.propertyId).toBeNull();
  });

  it("an action the game's own schema rejects is a clean 400, not a 500", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    await seedSession({
      playerId, locationId, propertyId: null, wager: 10_000n,
      player: ["H10", "H9"], dealer: ["H9", "H10"], cursor: 0, shoe: [],
    });

    // "fold" is not in blackjack's `z.enum(["hit","stand","double"])`. The
    // envelope schema cannot catch it — the hub does not know a game's action
    // shape — so this is the boundary the plugin's own schema guards.
    const res = await act(token, "fold");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_action");

    // Refused, not applied: the hand is untouched.
    const [row] = await db.select().from(casinoSessions).where(eq(casinoSessions.playerId, playerId));
    expect(row?.status).toBe("open");
  });

  it("a move the game refuses by throwing is a clean 400, not a 500", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    // Three cards, so blackjack's `act` throws "can only double on the first
    // two cards". A game's own `Error` is not a `PluginError`, and
    // `routes.ts` re-throws anything else.
    await seedSession({
      playerId, locationId, propertyId: null, wager: 10_000n,
      player: ["H4", "H5", "H2"], dealer: ["H10", "H6"], cursor: 0, shoe: ["D9"],
    });

    const cashBefore = await cashOf(playerId);
    const res = await act(token, "double");
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; detail?: string; step?: string }>();
    expect(body.error).toBe("game_error");
    // The game's own words survive, so a page can say more than a code.
    expect(body.detail).toMatch(/double/i);
    expect(body.step).toBe("act");

    expect(await cashOf(playerId)).toBe(cashBefore);
  });

  it("settles against the house FROZEN at play, not whoever owns the table now", async () => {
    // Spec §4.1: `property_id` is "resolved at `play` and frozen for the hand",
    // and §4.3 gives the reason — a house that changes hands mid-hand must not
    // move the payout to someone who never took the wager. The route used to
    // re-resolve the house on every `act`, so this hand's payout was debited
    // from whoever happened to own the table at the moment it settled.
    const { token, playerId } = await register();
    const { playerId: latecomerId } = await register();
    const locationId = await seedLocation();

    const wager = 10_000n;
    // The town was UNOWNED at `play`: the wager sank, nobody was credited.
    await placePlayer(playerId, locationId, 1_000_000n - wager);
    await placePlayer(latecomerId, locationId, 10_000_000n);

    const { sessionId } = await seedSession({
      playerId, locationId, propertyId: null, wager,
      player: ["H10", "H9"], dealer: ["H9", "H10"], cursor: 0, shoe: [],
    });

    // ...and someone buys the table while the hand is in play.
    await seedHouse(locationId, latecomerId, 0n);

    const cashBefore = await cashOf(playerId);
    const latecomerBefore = await cashOf(latecomerId);

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(200);
    const payout = BigInt(res.json<{ payout: string }>().payout);
    expect(payout).toBe(wager); // push

    // The player is paid either way — the hand is theirs.
    expect(await cashOf(playerId)).toBe(cashBefore + payout);
    // The new owner is NOT debited for a wager they never received.
    expect(await cashOf(latecomerId)).toBe(latecomerBefore);

    const row = await sessionRow(sessionId);
    expect(row?.propertyId).toBeNull();
    expect(row?.status).toBe("settled");
  });

  it("refuses to act on a hand that has already expired", async () => {
    // The lobby hides an expired hand and `play` forfeits it; `act` used to
    // carry on playing one indefinitely, which made the lobby's own comment
    // ("a Resume that `act` answers 409 to") false. All three now agree.
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    const { sessionId } = await seedSession({
      playerId, locationId, propertyId: null, wager: 10_000n,
      player: ["H10", "H9"], dealer: ["H9", "H10"], cursor: 0, shoe: [],
      createdAt: new Date(Date.now() - 45 * 60_000),   // default expiry is 30m
    });

    const cashBefore = await cashOf(playerId);
    const res = await act(token, "stand");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("session_expired");

    // Refused, not settled: the row stays open for the forfeit `play` does,
    // and no money moves here.
    expect(await cashOf(playerId)).toBe(cashBefore);
    const row = await sessionRow(sessionId);
    expect(row?.status).toBe("open");
    expect(row?.settledAt).toBeNull();
  });

  it("acting on another player's session: 404", async () => {
    const { playerId: ownerA } = await register();
    const { token: tokenB } = await register(); // B never played
    const locationId = await seedLocation();
    await placePlayer(ownerA, locationId, 1_000_000n);

    await seedSession({
      playerId: ownerA, locationId, propertyId: null, wager: 10_000n,
      player: ["H10", "H9"], dealer: ["H9", "H10"], cursor: 0, shoe: [],
    });

    const res = await act(tokenB, "stand");
    expect(res.statusCode).toBe(404);
  });

  // The bankruptcy takeover. `assertHouseCanCover` refuses a hand the house
  // cannot pay AT `play` AND on every raise, but the owner's cash can fall
  // between those checks and the settle (they spend it elsewhere, or a bounty
  // lands), and `payOwner` then CLAMPS the debit — the winner used to be paid
  // in full out of a faucet and the owner kept the table. Now they lose it.
  it("bankrupts the house: the winner takes ownership of the table", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 500n);
    const wager = 10_000n;
    await placePlayer(playerId, locationId, 1_000_000n - wager);
    // The owner holds LESS than the 20_000n this hand is about to pay out —
    // the state `assertHouseCanCover` cannot rule out, because it ran before
    // the owner's cash moved.
    await placePlayer(ownerId, locationId, 5_000n);

    const cashBefore = await cashOf(playerId);

    // Player stands on 5, dealer draws D9 onto 16 and busts: pays 2x.
    await seedSession({
      playerId, locationId, propertyId, wager,
      player: ["H2", "H3"], dealer: ["H10", "H6"], cursor: 0, shoe: ["D9"],
    });

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ done: boolean; payout: string; houseSeized: boolean }>();
    expect(body.done).toBe(true);
    expect(BigInt(body.payout)).toBe(wager * 2n);
    expect(body.houseSeized).toBe(true);

    // The winner is paid IN FULL — the takeover is on top of the money, not
    // instead of it.
    expect(await cashOf(playerId)).toBe(cashBefore + wager * 2n);
    // The house paid every cent it had, and the clamp took it to zero.
    expect(await cashOf(ownerId)).toBe(0n);

    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row?.ownerPlayerId).toBe(playerId);
    // The lever does not survive its owner — `transfer` and `drop` zero it too.
    expect(row?.cost).toBe(0n);

    // Both sides are told, by notification: casino publishes no event per hand.
    const notes = await db.select().from(notifications).where(eq(notifications.playerId, ownerId));
    expect(notes.some((n) => n.body.includes("took over your"))).toBe(true);
    const winnerNotes = await db.select().from(notifications).where(eq(notifications.playerId, playerId));
    expect(winnerNotes.some((n) => n.body.includes("you took ownership of the casino"))).toBe(true);
  });

  it("never seizes an UNOWNED house — a faucet cannot go bankrupt", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    const wager = 10_000n;
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    await seedSession({
      playerId, locationId, propertyId: null, wager,
      player: ["H2", "H3"], dealer: ["H10", "H6"], cursor: 0, shoe: ["D9"],
    });

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ payout: string; houseSeized: boolean }>();
    expect(BigInt(body.payout)).toBe(wager * 2n);
    expect(body.houseSeized).toBe(false);
  });

  it("an owner who bankrupts their own table does not seize it from themselves", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, playerId, 500n);
    const wager = 10_000n;
    // One player, both roles: the payout debits and credits the same person,
    // so the clamp can bite while nobody else is involved at all.
    await placePlayer(playerId, locationId, 5_000n);

    await seedSession({
      playerId, locationId, propertyId, wager,
      player: ["H2", "H3"], dealer: ["H10", "H6"], cursor: 0, shoe: ["D9"],
    });

    const res = await act(token, "stand");
    expect(res.statusCode).toBe(200);
    expect(res.json<{ houseSeized: boolean }>().houseSeized).toBe(false);

    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row?.ownerPlayerId).toBe(playerId);
    // The lever is untouched: nothing changed hands.
    expect(row?.cost).toBe(500n);
  });
});
