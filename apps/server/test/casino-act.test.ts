import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
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
}): Promise<Seeded> {
  const sessionId = uuidv7();
  await db.insert(casinoSessions).values({
    id: sessionId,
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
    const hitBody = hitRes.json<{ done: boolean }>();
    expect(hitBody.done).toBe(false);
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
    const body = res.json<{ done: boolean; payout: string }>();
    expect(body.done).toBe(true);

    const newWager = wager * 2n; // 20,000
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
});
