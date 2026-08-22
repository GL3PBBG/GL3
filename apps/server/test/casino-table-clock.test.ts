import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actSeat, dealTable, settleTable, type BjTableState } from "@gl3/plugin-blackjack";
import { loadConfig } from "../src/config.js";
import { locations, settings, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSeats, casinoTables, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The lazy table clock — `advanceTable`, and the four routes that call it.
 *
 * NOTHING HERE SLEEPS. A deadline lapses because the test writes a past
 * `deadline_at` onto the row, which is also what makes the successor deadline
 * assertable to the millisecond: the clock is EAGER-EQUIVALENT, so a deal or
 * an auto-stand fired by a lapse dates its successor from the deadline that
 * lapsed, never from the moment the read happened to arrive. That is the
 * property that lets one read play a wholly abandoned hand out to settlement
 * (spec §5: "repeat until the clock is in the future or the hand settles") —
 * with a `now`-based successor every auto-stand would push the next seat's
 * turn 30 seconds into the future and the table would need one poll per seat.
 *
 * Deals are deterministic in `p_casino_tables.seed`, so every figure is
 * computed from blackjack's own pure functions — `casino-table-money.test.ts`'s
 * `probeSeed` idiom, copied deliberately rather than shared: the two files
 * pick different deals for different reasons.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Clocker${regCounter}`,
    remoteAddress: `10.65.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
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

/** `cost` is the owner's lever (V2 blackjack.inc.php:276); 0n means unset. */
async function seedHouse(locationId: string, ownerId: string, cost: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId, pluginId: "blackjack", ownerPlayerId: ownerId, cost, profit: 0n,
  });
  return id;
}

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats)
    .set({ locationId, cash, jailedUntil: null, hospitalUntil: null })
    .where(eq(playerStats.playerId, playerId));
}

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats)
    .where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

/** Cash-kind ledger total for one player — `casino-lock-order.test.ts`'s idiom. */
const ledgerCashOf = async (id: string): Promise<bigint> => {
  const rows = await db
    .select({ amount: transactions.amount, kind: transactions.balanceKind })
    .from(transactions)
    .where(eq(transactions.playerId, id));
  return rows.reduce((sum, r) => sum + (r.kind === "cash" ? r.amount : 0n), 0n);
};

function sit(token: string, gameId = "blackjack") {
  return app.inject({
    method: "POST", url: "/api/casino/table/sit",
    headers: { authorization: `Bearer ${token}` }, payload: { gameId },
  });
}

function leave(token: string) {
  return app.inject({
    method: "POST", url: "/api/casino/table/leave",
    headers: { authorization: `Bearer ${token}` }, payload: {},
  });
}

function tableView(token: string) {
  return app.inject({
    method: "GET", url: "/api/casino/table",
    headers: { authorization: `Bearer ${token}` },
  });
}

function bet(token: string, wager: bigint | string) {
  return app.inject({
    method: "POST", url: "/api/casino/table/bet",
    headers: { authorization: `Bearer ${token}` }, payload: { wager: String(wager) },
  });
}

function tableAct(token: string, action: unknown) {
  return app.inject({
    method: "POST", url: "/api/casino/table/act",
    headers: { authorization: `Bearer ${token}` }, payload: { action },
  });
}

interface SeatPayload { seat: number; username: string; wager: string; leaving: boolean; idleHands: number }
interface TablePayload {
  tableId: string; phase: string; handNo: number; turnSeat: number | null;
  deadlineAt: string | null; mySeat: number | null; seats: SeatPayload[]; view: unknown;
}

const payloadOf = (raw: string): TablePayload | null =>
  (JSON.parse(raw) as { table: TablePayload | null }).table;

async function tableRow(tableId: string) {
  const [row] = await db.select().from(casinoTables).where(eq(casinoTables.id, tableId));
  return row;
}

async function seatRow(tableId: string, playerId: string) {
  const [row] = await db.select().from(casinoSeats)
    .where(and(eq(casinoSeats.tableId, tableId), eq(casinoSeats.playerId, playerId)));
  return row;
}

async function setSeed(tableId: string, seed: string): Promise<void> {
  await db.update(casinoTables).set({ seed }).where(eq(casinoTables.id, tableId));
}

/**
 * Lapses the table's clock by writing a PAST `deadline_at` — the whole file's
 * substitute for waiting. Returns the instant written, because every successor
 * deadline is measured from it.
 */
async function backdate(tableId: string, secondsAgo: number): Promise<Date> {
  const lapsed = new Date(Date.now() - secondsAgo * 1000);
  await db.update(casinoTables).set({ deadlineAt: lapsed })
    .where(eq(casinoTables.id, tableId));
  return lapsed;
}

/** The stored hands, as the jsonb codec leaves them: only `wager` is tagged. */
interface StoredState { hands: { seat: number; phase: string }[]; turn: number | null; done: boolean }
const storedState = (raw: unknown): StoredState => raw as StoredState;

/** `casino-table-money.test.ts`'s scanner: a case that needs a particular deal
 *  FINDS one rather than hand-building state the hub would never write. */
function probeSeed(
  seats: { seat: number; wager: bigint }[],
  pred: (state: BjTableState) => boolean,
  prefix: string,
): string {
  for (let i = 0; i < 4000; i += 1) {
    const seed = `${prefix}-${i}`;
    if (pred(dealTable(seats, seed))) return seed;
  }
  throw new Error(`no seed matched for ${prefix}`);
}

/** Resolves to "TIMEOUT" rather than hanging the file — the fast path's proof
 *  is that a request ANSWERS while a conflicting row lock is held. */
async function withinTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => { resolve("TIMEOUT"); }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

beforeAll(async () => {
  await resetDb(db);

  // payOwner reads the franchise skim LIVE from the settings table. These
  // suites pin the CONSUMER contract (exact escrow/credit math), so the skim
  // is pinned off here; its own coverage lives in properties-pay-owner.test.ts.
  await db.insert(settings).values({ key: "properties.skim_percent", value: "0" });
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

/** A town with a solvent blackjack house, and `count` seated players at one
 *  table there. Every case in this file opens this way. */
async function seatTable(count: number): Promise<{
  tableId: string; locationId: string; ownerId: string; propertyId: string;
  players: { token: string; playerId: string; username: string }[];
}> {
  const locationId = await seedLocation();
  const { playerId: ownerId } = await register();
  const propertyId = await seedHouse(locationId, ownerId, 200_000n);
  await placePlayer(ownerId, locationId, 10_000_000n);

  const players: { token: string; playerId: string; username: string }[] = [];
  let tableId = "";
  for (let i = 0; i < count; i += 1) {
    const p = await register();
    await placePlayer(p.playerId, locationId, 1_000_000n);
    const res = await sit(p.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tableId: string; seat: number }>();
    expect(body.seat).toBe(i);
    if (i === 0) tableId = body.tableId;
    expect(body.tableId).toBe(tableId);
    players.push(p);
  }
  return { tableId, locationId, ownerId, propertyId, players };
}

const W = 10_000n;
/** The turn clock's default, `DEFAULT_TABLE_TURN_SECONDS`. */
const TURN_MS = 30_000;

describe("the betting deadline", () => {
  it("deals to the bettors and skips the seat that never bet, bumping its idle count", async () => {
    const { tableId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    // Only seat 0 stakes, so the table is NOT ready — the deal can come from
    // the clock and nothing else.
    expect((await bet(a.token, W)).statusCode).toBe(200);
    expect((await tableRow(tableId))?.phase).toBe("betting");

    const seed = probeSeed(
      [{ seat: 0, wager: W }], (s) => !s.done && s.hands[0]!.phase === "playing", "clock-solo",
    );
    await setSeed(tableId, seed);
    const lapsed = await backdate(tableId, 1);

    const res = await tableView(a.token);
    expect(res.statusCode).toBe(200);
    const payload = payloadOf(res.body);
    expect(payload?.phase).toBe("acting");
    expect(payload?.handNo).toBe(1);
    expect(payload?.turnSeat).toBe(0);
    expect(payload?.view).not.toBeNull();

    const row = await tableRow(tableId);
    expect(row?.phase).toBe("acting");
    expect(row?.state).not.toBeNull();
    // Only the seat that bet is in the hand.
    expect(storedState(row?.state).hands.map((h) => h.seat)).toEqual([0]);
    // EAGER EQUIVALENCE: the first turn's clock starts when the betting clock
    // ended, not when this read arrived.
    expect(row?.deadlineAt?.getTime()).toBe(lapsed.getTime() + TURN_MS);

    // The seat that sat it out is still seated, one hand idler.
    const bSeat = await seatRow(tableId, b.playerId);
    expect(bSeat).toBeDefined();
    expect(bSeat?.wager).toBe(0n);
    expect(bSeat?.idleHands).toBe(1);
    expect(payload?.seats.find((s) => s.seat === 1)?.idleHands).toBe(1);
    // The idler paid nothing for the privilege.
    expect(await cashOf(b.playerId)).toBe(1_000_000n);
  });

  it("kicks a seat that idles through table_idle_kick_hands deals", async () => {
    const { tableId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    const seed = probeSeed(
      [{ seat: 0, wager: W }], (s) => !s.done && s.hands[0]!.phase === "playing", "clock-kick",
    );

    // Three lapsed deals: A stakes every one, B never does. The default
    // `table_idle_kick_hands` is 3, so the third deal frees B's seat.
    for (const hand of [1, 2, 3]) {
      expect((await bet(a.token, W)).statusCode).toBe(200);
      await setSeed(tableId, seed);
      await backdate(tableId, 1);

      const dealt = await tableView(a.token);
      expect(dealt.statusCode).toBe(200);
      expect(payloadOf(dealt.body)?.handNo).toBe(hand);
      expect(payloadOf(dealt.body)?.phase).toBe("acting");

      if (hand < 3) {
        const bSeat = await seatRow(tableId, b.playerId);
        expect(bSeat?.idleHands).toBe(hand);
      }

      // Play the hand out so the table returns to betting for the next one.
      expect((await tableAct(a.token, "stand")).statusCode).toBe(200);
      expect((await tableRow(tableId))?.phase).toBe("betting");
      // A's own idle count is cleared by betting, never accrued.
      expect((await seatRow(tableId, a.playerId))?.idleHands).toBe(0);
    }

    expect(await seatRow(tableId, b.playerId)).toBeUndefined();
    // Kicked, not robbed: B never staked anything, so nothing moved.
    expect(await cashOf(b.playerId)).toBe(1_000_000n);
    expect(await ledgerCashOf(b.playerId)).toBe(0n);
    // The table lives on with the seat that plays.
    expect(await tableRow(tableId)).toBeDefined();
    expect(await seatRow(tableId, a.playerId)).toBeDefined();
  });
});

describe("the turn deadline", () => {
  it("auto-stands the timed-out seat and moves on", async () => {
    const { tableId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "clock-turn");

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);
    expect((await tableRow(tableId))?.turnSeat).toBe(0);

    const aCash = await cashOf(a.playerId);
    const lapsed = await backdate(tableId, 1);

    // The OTHER player's read is what fires it — the clock belongs to the
    // table, not to whoever timed out.
    const res = await tableView(b.token);
    expect(res.statusCode).toBe(200);
    const payload = payloadOf(res.body);
    expect(payload?.phase).toBe("acting");
    expect(payload?.turnSeat).toBe(1);
    expect(payload?.mySeat).toBe(1);

    const row = await tableRow(tableId);
    expect(row?.turnSeat).toBe(1);
    expect(storedState(row?.state).hands.find((h) => h.seat === 0)?.phase).toBe("stood");
    expect(storedState(row?.state).hands.find((h) => h.seat === 1)?.phase).toBe("playing");
    expect(row?.deadlineAt?.getTime()).toBe(lapsed.getTime() + TURN_MS);

    // An auto-stand moves NO money and raises NO wager (`applyStep` with a
    // null acting seat refuses every delta).
    expect(await cashOf(a.playerId)).toBe(aCash);
    expect((await seatRow(tableId, a.playerId))?.wager).toBe(W);

    // The seat that timed out is still seated and cannot act again.
    const late = await tableAct(a.token, "hit");
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: string }>().error).toBe("not_your_turn");
  });

  it("plays a fully abandoned hand to settlement on one read", async () => {
    const { tableId, ownerId, propertyId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "clock-abandon");
    const finalState = actSeat(actSeat(dealTable(bettors, seed), 0, "stand").state, 1, "stand").state;
    const payouts = new Map(settleTable(finalState).map((p) => [p.seat, p.payout]));
    const payoutA = payouts.get(0)!;
    const payoutB = payouts.get(1)!;

    const aCashBefore = await cashOf(a.playerId);
    const bCashBefore = await cashOf(b.playerId);
    const aLedgerBefore = await ledgerCashOf(a.playerId);
    const bLedgerBefore = await ledgerCashOf(b.playerId);
    const ownerCashBefore = await cashOf(ownerId);
    const ownerLedgerBefore = await ledgerCashOf(ownerId);

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);

    // Five minutes ago: seat 0's turn lapsed then, seat 1's thirty seconds
    // after that — BOTH are in the past, so one read owes two auto-stands and
    // the settle between them.
    await backdate(tableId, 300);

    const res = await tableView(a.token);
    expect(res.statusCode).toBe(200);
    const payload = payloadOf(res.body);
    expect(payload?.phase).toBe("betting");
    // The settled hand is still on screen — `settleHand` retains `state`
    // (spec §6) so the read that owed the table two auto-stands SHOWS the
    // result it just produced rather than an empty table.
    expect(payload?.view).not.toBeNull();
    expect(payload?.turnSeat).toBeNull();
    expect(payload?.deadlineAt).toBeNull();
    expect(payload?.seats.map((s) => s.wager)).toEqual(["0", "0"]);

    const row = await tableRow(tableId);
    expect(row?.phase).toBe("betting");
    expect(row?.state).not.toBeNull();
    expect(row?.handNo).toBe(1);
    expect(row?.deadlineAt).toBeNull();

    // Both hands were stood, not abandoned: the money is exactly what the
    // rules say, on every leg (rule 3).
    expect(await cashOf(a.playerId)).toBe(aCashBefore - W + payoutA);
    expect(await cashOf(b.playerId)).toBe(bCashBefore - W + payoutB);
    expect(await ledgerCashOf(a.playerId)).toBe(aLedgerBefore - W + payoutA);
    expect(await ledgerCashOf(b.playerId)).toBe(bLedgerBefore - W + payoutB);
    const houseNet = 2n * W - payoutA - payoutB;
    expect(await cashOf(ownerId)).toBe(ownerCashBefore + houseNet);
    expect(await ledgerCashOf(ownerId)).toBe(ownerLedgerBefore + houseNet);
    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(prop?.profit).toBe(houseNet);

    // Both seats survive the settle and the table is ready for the next hand.
    expect((await seatRow(tableId, a.playerId))?.wager).toBe(0n);
    expect((await seatRow(tableId, b.playerId))?.wager).toBe(0n);
  });
});

describe("the clock in sit and leave", () => {
  it("leave on a fully-lapsed acting table settles first and frees the seat now", async () => {
    const { tableId, ownerId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "clock-leave");
    const finalState = actSeat(actSeat(dealTable(bettors, seed), 0, "stand").state, 1, "stand").state;
    const payouts = new Map(settleTable(finalState).map((p) => [p.seat, p.payout]));
    const payoutA = payouts.get(0)!;
    const payoutB = payouts.get(1)!;

    const aCashBefore = await cashOf(a.playerId);
    const bCashBefore = await cashOf(b.playerId);
    const ownerCashBefore = await cashOf(ownerId);

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);
    await backdate(tableId, 300);

    // Without the clock inside `leave`, A's wager is still on the seat and
    // this answers `deferred: true` with the seat still there.
    const res = await leave(a.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ left: boolean; deferred: boolean }>()).toEqual({ left: true, deferred: false });

    expect(await seatRow(tableId, a.playerId)).toBeUndefined();
    expect(await seatRow(tableId, b.playerId)).toBeDefined();
    const row = await tableRow(tableId);
    expect(row?.phase).toBe("betting");
    // Retained (spec §6): B, who is still at the table, sees the hand A's
    // leave settled on the next poll.
    expect(row?.state).not.toBeNull();
    expect(row?.handNo).toBe(1);

    // The hand it settled on the way out paid both seats in full.
    expect(await cashOf(a.playerId)).toBe(aCashBefore - W + payoutA);
    expect(await cashOf(b.playerId)).toBe(bCashBefore - W + payoutB);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore + 2n * W - payoutA - payoutB);
  });

  it("sit fires a lapsed deal before seating the newcomer", async () => {
    const { tableId, locationId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    expect((await bet(a.token, W)).statusCode).toBe(200);
    const seed = probeSeed(
      [{ seat: 0, wager: W }], (s) => !s.done && s.hands[0]!.phase === "playing", "clock-sit",
    );
    await setSeed(tableId, seed);
    const lapsed = await backdate(tableId, 1);

    const c = await register();
    await placePlayer(c.playerId, locationId, 1_000_000n);
    const res = await sit(c.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tableId: string; seat: number }>();
    expect(body.tableId).toBe(tableId);
    expect(body.seat).toBe(2);

    // The deal fired BEFORE the newcomer's row existed, so it holds no stake
    // and the idle sweep never saw it.
    const cSeat = await seatRow(tableId, c.playerId);
    expect(cSeat?.wager).toBe(0n);
    expect(cSeat?.idleHands).toBe(0);

    const row = await tableRow(tableId);
    expect(row?.phase).toBe("acting");
    expect(row?.handNo).toBe(1);
    expect(storedState(row?.state).hands.map((h) => h.seat)).toEqual([0]);
    expect(row?.deadlineAt?.getTime()).toBe(lapsed.getTime() + TURN_MS);
    // The seat that was there and did not bet took the idle hand instead.
    expect((await seatRow(tableId, b.playerId))?.idleHands).toBe(1);
  });
});

describe("leaving a seat that holds no stake", () => {
  it("needs neither the game nor the clock, so an uninstalled game cannot strand a player", async () => {
    // A table whose game plugin is NOT installed — the state an operator
    // leaves behind by uninstalling a game with players still seated. Seeded
    // directly because no route can produce it: `sit` refuses an unknown game.
    const locationId = await seedLocation();
    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);

    const goneTableId = uuidv7();
    await db.insert(casinoTables).values({
      id: goneTableId, gameId: "gone", locationId, propertyId: null, seed: "deadbeef",
    });
    await db.insert(casinoSeats).values({
      id: uuidv7(), tableId: goneTableId, playerId, seatNo: 0,
    });

    // `p_casino_seats`' UNIQUE(player_id) is game-wide, so until this seat is
    // freed the player cannot sit ANYWHERE.
    const blocked = await sit(token);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: string }>().error).toBe("already_seated");

    const res = await leave(token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ left: boolean; deferred: boolean }>()).toEqual({ left: true, deferred: false });

    expect(await seatRow(goneTableId, playerId)).toBeUndefined();
    expect(await tableRow(goneTableId)).toBeUndefined();

    // And the player is playing again.
    const again = await sit(token);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ seat: number }>().seat).toBe(0);
  });
});

describe("the read fast path", () => {
  it("takes no row locks when no deadline has lapsed", async () => {
    const { tableId, ownerId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    // A live betting clock, pushed an hour out so no wall-clock slowness in
    // the suite can turn this case into the slow path by accident.
    expect((await bet(a.token, W)).statusCode).toBe(200);
    await db.update(casinoTables).set({ deadlineAt: new Date(Date.now() + 3_600_000) })
      .where(eq(casinoTables.id, tableId));

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    let pending: Promise<LightMyRequestResponse> | null = null;
    let raced: LightMyRequestResponse | "TIMEOUT" = "TIMEOUT";
    try {
      await t0`BEGIN`;
      // EVERY row the slow path would lock: the table row (`lockTable`'s
      // `FOR UPDATE`) and all three player_stats rows (`tx.locks.player` over
      // the seated players and the house owner).
      await t0`SELECT id FROM p_casino_tables WHERE id = ${tableId}::uuid FOR UPDATE`;
      await t0`
        SELECT player_id FROM player_stats
        WHERE player_id IN (${a.playerId}::uuid, ${b.playerId}::uuid, ${ownerId}::uuid)
        ORDER BY player_id FOR UPDATE
      `;

      pending = tableView(a.token);
      raced = await withinTimeout(pending, 5_000);
    } finally {
      try {
        await t0`ROLLBACK`;
      } catch {
        /* already rolled back */
      }
      t0.release();
      await blocker.end();
    }

    // Released before asserting, so a regression fails rather than hangs. The
    // null guard matters: a `BEGIN` that failed would leave `pending` unset,
    // and the infra error should surface instead of a TypeError on top of it.
    expect(pending).not.toBeNull();
    const res = await pending!;
    expect(raced).not.toBe("TIMEOUT");
    expect(res.statusCode).toBe(200);

    // And it is a real render, not an empty one.
    const payload = payloadOf(res.body);
    expect(payload?.tableId).toBe(tableId);
    expect(payload?.phase).toBe("betting");
    expect(payload?.mySeat).toBe(0);
    expect(payload?.seats).toHaveLength(2);
    expect(payload?.seats.find((s) => s.seat === 0)?.wager).toBe(W.toString());
    // The frozen house's lever reached the payload through the unlocked read.
    expect((JSON.parse(res.body) as { table: { maxBet: string } }).table.maxBet).toBe("200000");
  }, 30_000);
});
