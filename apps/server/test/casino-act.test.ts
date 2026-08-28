import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { games, type GameDef, type GameStep } from "@gl3/plugin-casino";
import { definePlugin, on, type PluginManifest } from "@gl3/plugin-sdk";
import { locations, settings, notifications, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { faroPlugin } from "./helpers/faro.js";
import { casinoSessions, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * POST /api/casino/act — wagerDelta, settle, payout.
 *
 * Runs against FARO, a deterministic synthetic solo game installed via
 * `bootTestServer({ plugins: [faroPlugin, throwsPlugin] })` — blackjack is a
 * table game now and no longer lives in the solo `casino.games` registry
 * (see `test/helpers/faro.ts`). Every action except `wait` settles, so most
 * hands here are a single `act` call rather than the old hit-then-stand
 * sequence; `wait` is FARO's one non-settling move, standing in for
 * blackjack's `hit` so the hub's non-settling `act` branch still has coverage.
 *
 * Every hand here is seeded DIRECTLY into `p_casino_sessions` with a
 * hand-built `FaroState`, exactly `casino-play.test.ts`'s "refuses a second
 * play while one is open" idiom: this file is about `act`'s own money
 * movements (a `wagerDelta` escrow, and `settleSession`'s payout), and a real
 * FARO `play` has no interesting branches for it to exercise.
 *
 * Money bookkeeping: seeding a session is standing in for a `play` call that
 * already happened, so each test sets the player's and (if any) owner's cash
 * to reflect the wager already having been escrowed — the same shape
 * `escrow()` itself leaves behind. `act`'s own money movements (a
 * `wagerDelta` escrow, and `settleSession`'s payout) are what's under test.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Dealer${regCounter}`,
    remoteAddress: `10.61.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
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
    id, locationId, pluginId: "faro", ownerPlayerId: ownerId, cost, profit: 0n,
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

/** Inserts an open (or, for the `session_closed` test, already-settled)
 *  session with a hand-built `FaroState` — `{ wager, outcome: "open" }` — so
 *  `act`'s own decision (the ACTION, not the state) drives the outcome. */
async function seedSession(opts: {
  playerId: string;
  locationId: string;
  propertyId: string | null;
  wager: bigint;
  gameId?: string;
  status?: "open" | "settled";
  createdAt?: Date;
}): Promise<Seeded> {
  const sessionId = uuidv7();
  await db.insert(casinoSessions).values({
    id: sessionId,
    ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
    playerId: opts.playerId,
    gameId: opts.gameId ?? "faro",
    locationId: opts.locationId,
    propertyId: opts.propertyId,
    wager: opts.wager,
    state: { wager: bi(opts.wager), outcome: "open" },
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

/**
 * A synthetic game whose `act` always throws — the 400-not-500 "throwing
 * game" test used to lean on blackjack's own "can only double on the first
 * two cards" check; blackjack left the solo registry (Task 5) and none of
 * FARO's actions refuse, so this test builds its own one-off manifest, the
 * same shape `casino-rogue-game.test.ts`'s "becomes a clean error from
 * `act`" describe block already proves — reproduced here over HTTP via
 * `app.inject` rather than `callPluginRoute`, to match this file's own idiom.
 */
const THROWS: GameDef<{ wager: bigint }> = {
  id: "throws",
  name: "Throws",
  maxPayoutMultiplier: 2,
  action: z.unknown(),
  start: ({ wager }): GameStep<{ wager: bigint }> => (
    { state: { wager }, view: { kind: "text", value: "throws: place your call" }, done: false }
  ),
  act: (): GameStep<{ wager: bigint }> => { throw new Error("the game refuses this move"); },
  settle: (_state, wager) => wager * 2n,
  view: () => ({ kind: "text", value: "throws" }),
};

const throwsPlugin: PluginManifest = definePlugin({
  id: "throws",
  version: "1.0.0",
  basePaths: ["/api/throws"],
  filters: [on(games, (_ctx, list) => [...list, THROWS as GameDef])],
});

/**
 * A solo game that DOES implement the generic-moves protocol — FARO's
 * `moves`-declaring twin, so the response's `moves` field has a game to
 * carry a real, bounded list from rather than only ever proving `null`.
 * `action` stays a fixed `Win now` button regardless of state — the field's
 * wiring is what's under test here, not a game's own decision logic (that is
 * `holdem`'s job, Task 4).
 */
const MOVER: GameDef<{ wager: bigint }> = {
  id: "mover",
  name: "Mover",
  maxPayoutMultiplier: 2,
  action: z.enum(["peek", "win"]),
  start: ({ wager }): GameStep<{ wager: bigint }> => (
    { state: { wager }, view: { kind: "text", value: "mover: ready" }, done: false }
  ),
  act: (state, action): GameStep<{ wager: bigint }> => (action === "win"
    ? { state, done: true, view: { kind: "text", value: "mover: won" } }
    : { state, done: false, view: { kind: "text", value: "mover: peeked" } }),
  settle: (_state, wager) => wager * 2n,
  view: () => ({ kind: "text", value: "mover" }),
  moves: () => [{ action: "win", label: "Win now" }],
};

const moverPlugin: PluginManifest = definePlugin({
  id: "mover",
  version: "1.0.0",
  basePaths: ["/api/mover"],
  filters: [on(games, (_ctx, list) => [...list, MOVER as GameDef])],
});

/**
 * `THROWS`'s twin for the `moves` handler specifically: `act` itself
 * behaves — it is `moves` that blows up. Proves `stepMoves`'s own
 * `guardGame` wrapping (`index.ts`), the same clean-400 contract every other
 * `GameDef` handler on this path already gets, rather than a raw throw
 * escaping as an unhandled 500.
 */
const MOVES_THROWS: GameDef<{ wager: bigint }> = {
  id: "movesthrows",
  name: "MovesThrows",
  maxPayoutMultiplier: 2,
  action: z.unknown(),
  start: ({ wager }): GameStep<{ wager: bigint }> => (
    { state: { wager }, view: { kind: "text", value: "movesthrows: ready" }, done: false }
  ),
  act: (state): GameStep<{ wager: bigint }> => (
    { state, done: false, view: { kind: "text", value: "movesthrows: acted" } }
  ),
  settle: (_state, wager) => wager,
  view: () => ({ kind: "text", value: "movesthrows" }),
  moves: (): never => { throw new Error("moves blew up"); },
};

const movesThrowsPlugin: PluginManifest = definePlugin({
  id: "movesthrows",
  version: "1.0.0",
  basePaths: ["/api/movesthrows"],
  filters: [on(games, (_ctx, list) => [...list, MOVES_THROWS as GameDef])],
});

beforeAll(async () => {
  await resetDb(db);

  // payOwner reads the franchise skim LIVE from the settings table. These
  // suites pin the CONSUMER contract (exact escrow/credit math), so the skim
  // is pinned off here; its own coverage lives in properties-pay-owner.test.ts.
  await db.insert(settings).values({ key: "properties.skim_percent", value: "0" });
  ({ app, close: closeServer, redis } = await bootTestServer({
    plugins: [faroPlugin, throwsPlugin, moverPlugin, movesThrowsPlugin],
  }));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("POST /api/casino/act", () => {
  it("a win settles the hand, and the player's net across it equals payout - wager", async () => {
    // Was "hits then stands...", a two-call hit-then-stand sequence:
    // blackjack-specific multi-turn play. FARO models the "settling" half of
    // that sequence with a single `act("win")` — the non-settling half (the
    // old `hit`) is covered separately below by `act("wait")`.
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    // Escrow already happened at (a hypothetical) `play`: player is down the
    // wager, owner is up it.
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    const { sessionId } = await seedSession({ playerId, locationId, propertyId, wager });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const res = await act(token, "win");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ done: boolean; payout: string }>();
    expect(body.done).toBe(true);
    const payout = BigInt(body.payout);
    expect(payout).toBe(wager * 2n);

    expect(await cashOf(playerId)).toBe(cashBefore + payout);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - payout);

    const row = await sessionRow(sessionId);
    expect(row?.status).toBe("settled");
    expect(row?.settledAt).not.toBeNull();
  });

  it("a non-settling act persists state and moves no money — and the hand still settles afterward", async () => {
    // `act("wait")` is FARO's stand-in for blackjack's `hit`: the hub's
    // non-settling branch (`index.ts`'s `done: false` response — state and
    // wager persisted, no settle) had no coverage anywhere in the tree once
    // blackjack left the solo registry, since every OTHER FARO action settles
    // immediately.
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    const { sessionId } = await seedSession({ playerId, locationId, propertyId, wager });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const waitRes = await act(token, "wait");
    expect(waitRes.statusCode).toBe(200);
    const waitBody = waitRes.json<{ done: boolean; wager: string; moves: unknown }>();
    expect(waitBody.done).toBe(false);
    // The unfinished branch reports the wager too — an act that does not
    // raise it still has to say what it is.
    expect(waitBody.wager).toBe(wager.toString());
    // FARO declares no `moves` method — `null`, not `[]`, is the client's
    // fall-back-to-legacy-UI signal.
    expect(waitBody.moves).toBeNull();
    // No money moves on a non-settling act.
    expect(await cashOf(playerId)).toBe(cashBefore);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore);

    const waitedRow = await sessionRow(sessionId);
    expect(waitedRow?.status).toBe("open");
    expect(waitedRow?.wager).toBe(wager);

    // And the hand is still playable afterward — its state survived the
    // non-settling step, so a following action settles normally.
    const winRes = await act(token, "win");
    expect(winRes.statusCode).toBe(200);
    const winBody = winRes.json<{ done: boolean; payout: string }>();
    expect(winBody.done).toBe(true);
    const payout = BigInt(winBody.payout);
    expect(payout).toBe(wager * 2n);
    expect(await cashOf(playerId)).toBe(cashBefore + payout);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - payout);

    const finalRow = await sessionRow(sessionId);
    expect(finalRow?.status).toBe("settled");
  });

  // "never sends the dealer's hole card to a player who is still choosing"
  // deleted: it proved blackjack's own concealment over HTTP, which FARO
  // (no hole card, no multi-turn deal) cannot exercise. Superseded by
  // `casino-tables.test.ts` (Task 10), which re-proves concealment over HTTP
  // at a table.

  it("a push returns exactly the wager (net zero for both sides)", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    await seedSession({ playerId, locationId, propertyId, wager });

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const res = await act(token, "push");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ done: boolean; payout: string }>();
    expect(body.done).toBe(true);
    expect(BigInt(body.payout)).toBe(wager);

    expect(await cashOf(playerId)).toBe(cashBefore + wager);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - wager);
  });

  // "a natural pays 2.5x and the house is debited 2.5x" deleted: naturals are
  // a blackjack-specific rule (two-card 21), which FARO has no concept of.
  // Superseded by blackjack's own unit tests.

  it("double debits a second wager AND credits the house before the hand resolves", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);

    const wager = 10_000n;
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    // FARO's "double" emits `wagerDelta: state.wager` (raising the stake to
    // 2x) and settles as a win AT the doubled wager — `test/helpers/faro.ts`.
    const { sessionId } = await seedSession({ playerId, locationId, propertyId, wager });

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
    expect(payout).toBe(newWager * 2n); // win on the doubled wager

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

    const wager = 100_000n;
    // FARO's `maxPayoutMultiplier` is 2.5, same as blackjack's: the opening
    // exposure is 250,000 and the doubled exposure is 500,000. 300,000 sits
    // between the two — enough for a hypothetical opening bet, not enough for
    // the raise — so it is `assertHouseCanCover`'s RECHECK (which runs BEFORE
    // the delta is escrowed, `engine.ts`) that refuses this, not an opening
    // check that never ran here: the hand is seeded already open rather than
    // dealt through `play`.
    await placePlayer(ownerId, locationId, 300_000n);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    const preState = { wager: bi(wager), outcome: "open" };
    const { sessionId } = await seedSession({ playerId, locationId, propertyId, wager });

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
      playerId, locationId, propertyId: null, wager: 10_000n, status: "settled",
    });

    const res = await act(token, "win");
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

    const { sessionId } = await seedSession({ playerId, locationId, propertyId: null, wager });

    const cashBefore = await cashOf(playerId);
    const ledgerBefore = await ledgerSumOf(playerId);

    const res = await act(token, "push");
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

    await seedSession({ playerId, locationId, propertyId: null, wager: 10_000n });

    // "hit" is not in FARO's `z.enum(["win","lose","push","double"])`. The
    // envelope schema cannot catch it — the hub does not know a game's action
    // shape — so this is the boundary the plugin's own schema guards.
    const res = await act(token, "hit");
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

    // `THROWS`, a one-off manifest installed alongside FARO (above): its own
    // `Error` is not a `PluginError`, and `routes.ts` re-throws anything else.
    await seedSession({
      playerId, locationId, propertyId: null, wager: 10_000n, gameId: "throws",
    });

    const cashBefore = await cashOf(playerId);
    const res = await act(token, "go");
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; detail?: string; step?: string }>();
    expect(body.error).toBe("game_error");
    // The game's own words survive, so a page can say more than a code.
    expect(body.detail).toMatch(/refuses/i);
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

    const { sessionId } = await seedSession({ playerId, locationId, propertyId: null, wager });

    // ...and someone buys the table while the hand is in play.
    await seedHouse(locationId, latecomerId, 0n);

    const cashBefore = await cashOf(playerId);
    const latecomerBefore = await cashOf(latecomerId);

    const res = await act(token, "push");
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
      createdAt: new Date(Date.now() - 45 * 60_000),   // default expiry is 30m
    });

    const cashBefore = await cashOf(playerId);
    const res = await act(token, "win");
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

    await seedSession({ playerId: ownerA, locationId, propertyId: null, wager: 10_000n });

    const res = await act(tokenB, "win");
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

    await seedSession({ playerId, locationId, propertyId, wager });

    const res = await act(token, "win");
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

    await seedSession({ playerId, locationId, propertyId: null, wager });

    const res = await act(token, "win");
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

    await seedSession({ playerId, locationId, propertyId, wager });

    const res = await act(token, "win");
    expect(res.statusCode).toBe(200);
    expect(res.json<{ houseSeized: boolean }>().houseSeized).toBe(false);

    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row?.ownerPlayerId).toBe(playerId);
    // The lever is untouched: nothing changed hands.
    expect(row?.cost).toBe(500n);
  });
});

describe("POST /api/casino/act — the moves field", () => {
  it("carries the game's bounded moves on a non-settling step, and [] once the hand is done", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);
    const wager = 10_000n;
    await placePlayer(ownerId, locationId, 10_000_000n + wager);
    await placePlayer(playerId, locationId, 1_000_000n - wager);

    await seedSession({ playerId, locationId, propertyId, wager, gameId: "mover" });

    const peekRes = await act(token, "peek");
    expect(peekRes.statusCode).toBe(200);
    const peekBody = peekRes.json<{ done: boolean; moves: { action: unknown; label: string }[] }>();
    expect(peekBody.done).toBe(false);
    expect(peekBody.moves).toEqual([{ action: "win", label: "Win now" }]);

    const winRes = await act(token, "win");
    expect(winRes.statusCode).toBe(200);
    const winBody = winRes.json<{ done: boolean; moves: unknown }>();
    expect(winBody.done).toBe(true);
    // The hand is settled — no more legal moves, but the game DID implement
    // the method, so this is [] rather than null.
    expect(winBody.moves).toEqual([]);
  });

  it("a moves() that throws is a clean 400, not a 500 — the same guardGame contract act/settle already get", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    // `act` itself behaves; only `moves` blows up, so this proves `stepMoves`
    // has its own `guardGame` wrapping rather than piggy-backing on `act`'s.
    await seedSession({
      playerId, locationId, propertyId: null, wager: 10_000n, gameId: "movesthrows",
    });

    const res = await act(token, "anything");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("game_error");
  });
});
