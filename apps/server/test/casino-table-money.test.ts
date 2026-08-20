import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actSeat, dealTable, settleTable, type BjTableState } from "@gl3/plugin-blackjack";
import { locations, notifications, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSeats, casinoTables, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * POST /api/casino/table/bet and /act — the table money path.
 *
 * Every figure asserted here is computed from blackjack's own pure functions
 * (`dealTable` / `actSeat` / `settleTable`) rather than hand-written, which is
 * possible because the deal is deterministic in `p_casino_tables.seed` and the
 * seed is a COLUMN: a test picks a seed by scanning (`probeSeed`), writes it
 * onto the row, and the next deal consumes it. The hub rotates a fresh seed
 * onto the row only AFTER dealing, so the write has to land before the bet
 * that completes the table — see `dealIfReady`.
 *
 * There is no clock here: Task 11 owns `advanceTable`, so every deal in this
 * file fires through the instant path (every non-leaving seat has bet).
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Punter${regCounter}`,
    remoteAddress: `10.63.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
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
 * The scanning idiom `blackjack-table-rules.test.ts` uses: seeds are cheap and
 * the deal is pure, so a case that needs a particular deal FINDS one rather
 * than hand-building state the hub would never write.
 */
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

/** Every card code anywhere in a rendered ViewNode tree. */
function cardsIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) cardsIn(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.cards)) {
    for (const card of obj.cards) if (typeof card === "string") out.push(card);
  }
  for (const value of Object.values(obj)) cardsIn(value, out);
  return out;
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("betting", () => {
  it("escrows each seat's wager to the frozen house, exactly, and deals when all have bet", async () => {
    const W = 10_000n;
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    const propertyId = await seedHouse(locationId, ownerId, 200_000n);
    await placePlayer(ownerId, locationId, 10_000_000n);

    const seated: { token: string; playerId: string }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = await register();
      await placePlayer(p.playerId, locationId, 1_000_000n);
      seated.push(p);
    }

    const sitRes = await sit(seated[0]!.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(seated[1]!.token);
    await sit(seated[2]!.token);

    const bettors = [0, 1, 2].map((seat) => ({ seat, wager: W }));
    // Every seat still choosing, so the turn lands on seat 0 rather than
    // skipping a dealt natural.
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "three-live");
    const expected = dealTable(bettors, seed);

    const cashBefore = await Promise.all(seated.map((p) => cashOf(p.playerId)));
    const ledgerBefore = await Promise.all(seated.map((p) => ledgerCashOf(p.playerId)));
    const ownerCashBefore = await cashOf(ownerId);

    const stamped = Date.now();
    const first = await bet(seated[0]!.token, W);
    expect(first.statusCode).toBe(200);
    const firstPayload = payloadOf(first.body);
    expect(firstPayload?.phase).toBe("betting");
    // The FIRST bet starts the betting clock: now + table_bet_seconds (20).
    const betting = await tableRow(tableId);
    expect(betting?.deadlineAt).not.toBeNull();
    expect(betting!.deadlineAt!.getTime()).toBeGreaterThan(stamped + 14_000);
    expect(betting!.deadlineAt!.getTime()).toBeLessThanOrEqual(stamped + 21_000);
    expect(betting?.phase).toBe("betting");

    expect((await bet(seated[1]!.token, W)).statusCode).toBe(200);
    expect((await tableRow(tableId))?.phase).toBe("betting");

    await setSeed(tableId, seed);
    const dealt = Date.now();
    const last = await bet(seated[2]!.token, W);
    expect(last.statusCode).toBe(200);

    const row = await tableRow(tableId);
    expect(row?.phase).toBe("acting");
    expect(row?.handNo).toBe(1);
    expect(row?.state).not.toBeNull();
    expect(row?.turnSeat).toBe(expected.turn);
    expect(row?.turnSeat).toBe(0);
    // The row's seed ROTATED at the deal, so the next hand is not replayable
    // from this one.
    expect(row?.seed).not.toBe(seed);
    // now + table_turn_seconds (30).
    expect(row!.deadlineAt!.getTime()).toBeGreaterThan(dealt + 24_000);
    expect(row!.deadlineAt!.getTime()).toBeLessThanOrEqual(dealt + 31_000);

    // The response is the same envelope GET answers with.
    const payload = payloadOf(last.body);
    expect(payload?.phase).toBe("acting");
    expect(payload?.turnSeat).toBe(0);
    expect(payload?.mySeat).toBe(2);
    expect(payload?.view).not.toBeNull();
    expect(payload?.seats.map((s) => s.wager)).toEqual([W.toString(), W.toString(), W.toString()]);

    // Money: every seat paid exactly its wager, the house took all three.
    for (let i = 0; i < 3; i += 1) {
      expect(await cashOf(seated[i]!.playerId)).toBe(cashBefore[i]! - W);
      expect(await ledgerCashOf(seated[i]!.playerId)).toBe(ledgerBefore[i]! - W);
    }
    expect(await cashOf(ownerId)).toBe(ownerCashBefore + 3n * W);
    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(prop?.profit).toBe(3n * W);
  });

  it("refuses a bet outside min/lever bounds and outside the betting phase", async () => {
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    await seedHouse(locationId, ownerId, 200_000n);
    await placePlayer(ownerId, locationId, 10_000_000n);

    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);
    const sitRes = await sit(token);
    const { tableId } = sitRes.json<{ tableId: string }>();

    // A dealt natural settles the hand inside the deal, which would put the
    // table straight back into the betting phase — pin a live one.
    const seed = probeSeed(
      [{ seat: 0, wager: 10_000n }], (s) => !s.done && s.hands[0]!.phase === "playing", "solo-live",
    );
    await setSeed(tableId, seed);

    const cashBefore = await cashOf(playerId);

    const low = await bet(token, "50");           // default min_bet is 100
    expect(low.statusCode).toBe(400);
    expect(low.json<{ error: string }>().error).toBe("wager_below_min");

    const high = await bet(token, "200001");      // the owner's lever is 200,000
    expect(high.statusCode).toBe(400);
    expect(high.json<{ error: string }>().error).toBe("wager_above_max");

    expect(await cashOf(playerId)).toBe(cashBefore);

    // A lone seat is "every non-leaving seat", so this bet deals immediately.
    expect((await bet(token, "10000")).statusCode).toBe(200);

    const wrongPhase = await bet(token, "10000");
    expect(wrongPhase.statusCode).toBe(409);
    expect(wrongPhase.json<{ error: string }>().error).toBe("wrong_phase");
    // Refused before any escrow: the seat's stake is the one bet it made.
    expect(await cashOf(playerId)).toBe(cashBefore - 10_000n);
  });

  it("refuses the bet that would push total exposure past the house's cash", async () => {
    const W = 100_000n;                            // no lever → default max_bet
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    await seedHouse(locationId, ownerId, 0n);
    await placePlayer(ownerId, locationId, 300_000n);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, locationId, 1_000_000n);
    await placePlayer(b.playerId, locationId, 1_000_000n);
    const sitRes = await sit(a.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(b.token);

    const bCashBefore = await cashOf(b.playerId);

    // 100,000 × 2.5 = 250,000 ≤ 300,000. The escrow then RAISES the owner to
    // 400,000 — an already-escrowed wager counts toward covering the next one.
    expect((await bet(a.token, W)).statusCode).toBe(200);
    expect(await cashOf(ownerId)).toBe(400_000n);

    // 250,000 + 250,000 = 500,000 > 400,000.
    const refused = await bet(b.token, W);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe("house_cannot_cover");

    expect(await cashOf(b.playerId)).toBe(bCashBefore);
    expect((await seatRow(tableId, b.playerId))?.wager).toBe(0n);
    const row = await tableRow(tableId);
    expect(row?.phase).toBe("betting");
    expect(row?.handNo).toBe(0);
    expect(row?.state).toBeNull();
  });

  it("answers 409 wrong_location for a seated player who travelled away", async () => {
    const locationId = await seedLocation();
    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);
    const sitRes = await sit(token);
    const { tableId } = sitRes.json<{ tableId: string }>();

    const elsewhere = await seedLocation();
    await placePlayer(playerId, elsewhere, 1_000_000n);

    const cashBefore = await cashOf(playerId);
    const res = await bet(token, "10000");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("wrong_location");

    expect(await cashOf(playerId)).toBe(cashBefore);
    expect((await seatRow(tableId, playerId))?.wager).toBe(0n);
    expect((await tableRow(tableId))?.deadlineAt).toBeNull();
  });
});

describe("acting and settling", () => {
  it("plays a full 2-seat hand to settlement with conserved money", async () => {
    const W = 10_000n;
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    const propertyId = await seedHouse(locationId, ownerId, 200_000n);
    await placePlayer(ownerId, locationId, 10_000_000n);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, locationId, 1_000_000n);
    await placePlayer(b.playerId, locationId, 1_000_000n);
    const sitRes = await sit(a.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(b.token);

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "two-live");
    const dealtState = dealTable(bettors, seed);
    const afterA = actSeat(dealtState, 0, "stand").state;
    const finalState = actSeat(afterA, 1, "stand").state;
    const payouts = new Map(settleTable(finalState).map((p) => [p.seat, p.payout]));

    const aCashBefore = await cashOf(a.playerId);
    const bCashBefore = await cashOf(b.playerId);
    const aLedgerBefore = await ledgerCashOf(a.playerId);
    const bLedgerBefore = await ledgerCashOf(b.playerId);
    const ownerCashBefore = await cashOf(ownerId);
    const ownerLedgerBefore = await ledgerCashOf(ownerId);

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);
    expect((await tableRow(tableId))?.turnSeat).toBe(0);

    const outOfTurn = await tableAct(b.token, "stand");
    expect(outOfTurn.statusCode).toBe(409);
    expect(outOfTurn.json<{ error: string }>().error).toBe("not_your_turn");

    const first = await tableAct(a.token, "stand");
    expect(first.statusCode).toBe(200);
    expect(payloadOf(first.body)?.turnSeat).toBe(1);
    expect((await tableRow(tableId))?.turnSeat).toBe(afterA.turn);

    const last = await tableAct(b.token, "stand");
    expect(last.statusCode).toBe(200);

    // The hand settled: the row is reset, the seats keep their places.
    const row = await tableRow(tableId);
    expect(row?.phase).toBe("betting");
    expect(row?.state).toBeNull();
    expect(row?.turnSeat).toBeNull();
    expect(row?.deadlineAt).toBeNull();
    expect(row?.handNo).toBe(1);

    const payload = payloadOf(last.body);
    expect(payload?.phase).toBe("betting");
    expect(payload?.view).toBeNull();
    expect(payload?.seats).toHaveLength(2);

    expect((await seatRow(tableId, a.playerId))?.wager).toBe(0n);
    expect((await seatRow(tableId, b.playerId))?.wager).toBe(0n);

    const payoutA = payouts.get(0)!;
    const payoutB = payouts.get(1)!;
    expect(await cashOf(a.playerId)).toBe(aCashBefore - W + payoutA);
    expect(await cashOf(b.playerId)).toBe(bCashBefore - W + payoutB);
    expect(await ledgerCashOf(a.playerId)).toBe(aLedgerBefore - W + payoutA);
    expect(await ledgerCashOf(b.playerId)).toBe(bLedgerBefore - W + payoutB);

    // The house is the counterparty to both, cent for cent (rule 3).
    const houseNet = 2n * W - payoutA - payoutB;
    expect(await cashOf(ownerId)).toBe(ownerCashBefore + houseNet);
    expect(await ledgerCashOf(ownerId)).toBe(ownerLedgerBefore + houseNet);
    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(prop?.profit).toBe(houseNet);

    // The table survives for the next hand.
    expect((await bet(a.token, W)).statusCode).toBe(200);
  });

  it("double escrows the delta, re-checks cover, and refuses when the house cannot cover the raise", async () => {
    // PART ONE — a double the house CAN cover, at a two-seat table so the
    // raised wager is observable before the hand ends.
    const W = 10_000n;
    const richTown = await seedLocation();
    const { playerId: richOwner } = await register();
    await seedHouse(richTown, richOwner, 200_000n);
    await placePlayer(richOwner, richTown, 10_000_000n);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, richTown, 1_000_000n);
    await placePlayer(b.playerId, richTown, 1_000_000n);
    const sitRes = await sit(a.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(b.token);

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "two-double");
    const dealtState = dealTable(bettors, seed);
    const doubled = actSeat(dealtState, 0, "double");

    const aCashBefore = await cashOf(a.playerId);
    const ownerCashBefore = await cashOf(richOwner);

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);

    const res = await tableAct(a.token, "double");
    expect(res.statusCode).toBe(200);
    // A doubled seat is done; seat 1 is still choosing, so the hand lives on
    // and the raised stake is on the row.
    expect((await seatRow(tableId, a.playerId))?.wager).toBe(2n * W);
    expect((await tableRow(tableId))?.phase).toBe("acting");
    expect((await tableRow(tableId))?.turnSeat).toBe(doubled.state.turn);
    expect(await cashOf(a.playerId)).toBe(aCashBefore - 2n * W);
    // Both bets plus the double's delta.
    expect(await cashOf(richOwner)).toBe(ownerCashBefore + 3n * W);

    // PART TWO — the same double against a house that cannot cover it.
    const V = 100_000n;                            // no lever → default max_bet
    const poorTown = await seedLocation();
    const { playerId: poorOwner } = await register();
    await seedHouse(poorTown, poorOwner, 0n);
    await placePlayer(poorOwner, poorTown, 300_000n);

    const c = await register();
    await placePlayer(c.playerId, poorTown, 1_000_000n);
    const soloSit = await sit(c.token);
    const soloTable = soloSit.json<{ tableId: string }>().tableId;

    const soloSeed = probeSeed(
      [{ seat: 0, wager: V }], (s) => !s.done && s.hands[0]!.phase === "playing", "solo-double",
    );
    await setSeed(soloTable, soloSeed);
    expect((await bet(c.token, V)).statusCode).toBe(200);
    // 100,000 × 2.5 = 250,000 ≤ 300,000 passed; the escrow left the owner
    // holding 400,000, and 200,000 × 2.5 = 500,000 does not fit in that.
    const cCash = await cashOf(c.playerId);
    const ownerCash = await cashOf(poorOwner);

    const refused = await tableAct(c.token, "double");
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe("house_cannot_cover");

    // Rolled back whole: no second escrow, no state change, the hand lives.
    expect((await seatRow(soloTable, c.playerId))?.wager).toBe(V);
    expect(await cashOf(c.playerId)).toBe(cCash);
    expect(await cashOf(poorOwner)).toBe(ownerCash);
    const soloRow = await tableRow(soloTable);
    expect(soloRow?.phase).toBe("acting");
    expect(soloRow?.turnSeat).toBe(0);

    // Still playable: a hit is not a raise, so it goes through.
    expect((await tableAct(c.token, "hit")).statusCode).toBe(200);
  });

  it("hands the table to the first SHORT-PAID winner in seat order and still pays everyone in full", async () => {
    const W = 10_000n;
    const locationId = await seedLocation();
    const owner = await register();
    const propertyId = await seedHouse(locationId, owner.playerId, 200_000n);
    await placePlayer(owner.playerId, locationId, 10_000_000n);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, locationId, 1_000_000n);
    await placePlayer(b.playerId, locationId, 1_000_000n);
    const sitRes = await sit(a.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(b.token);

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    // BOTH seats must win, so the house owes two payouts and can be made to
    // come up short on the SECOND one only.
    const seed = probeSeed(bettors, (s) => {
      if (!s.hands.every((h) => h.phase === "playing")) return false;
      const end = actSeat(actSeat(s, 0, "stand").state, 1, "stand").state;
      return settleTable(end).every((p) => p.payout > 0n);
    }, "two-winners");
    const finalState = actSeat(actSeat(dealTable(bettors, seed), 0, "stand").state, 1, "stand").state;
    const payouts = new Map(settleTable(finalState).map((p) => [p.seat, p.payout]));
    const payoutA = payouts.get(0)!;
    const payoutB = payouts.get(1)!;

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);

    // Strictly between seat 0's payout and the sum: the house pays seat 0 IN
    // FULL and comes up short only at seat 1, so SEAT 1's player takes it.
    const houseCash = payoutA + payoutB / 2n;
    expect(houseCash).toBeGreaterThanOrEqual(payoutA);
    expect(houseCash).toBeLessThan(payoutA + payoutB);
    await db.update(playerStats).set({ cash: houseCash })
      .where(eq(playerStats.playerId, owner.playerId));

    const aCashBefore = await cashOf(a.playerId);
    const bCashBefore = await cashOf(b.playerId);

    expect((await tableAct(a.token, "stand")).statusCode).toBe(200);
    const last = await tableAct(b.token, "stand");
    expect(last.statusCode).toBe(200);

    // Both winners are paid IN FULL — the takeover is on top of the money.
    expect(await cashOf(a.playerId)).toBe(aCashBefore + payoutA);
    expect(await cashOf(b.playerId)).toBe(bCashBefore + payoutB);
    // The house paid every cent it had.
    expect(await cashOf(owner.playerId)).toBe(0n);

    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(prop?.ownerPlayerId).toBe(b.playerId);
    // The lever does not survive its owner.
    expect(prop?.cost).toBe(0n);

    // Both sides are told, by notification: casino publishes no event per hand.
    const ownerNotes = await db.select().from(notifications)
      .where(eq(notifications.playerId, owner.playerId));
    expect(ownerNotes.some((n) => n.body.includes("took over your"))).toBe(true);
    const winnerNotes = await db.select().from(notifications)
      .where(eq(notifications.playerId, b.playerId));
    expect(winnerNotes.some((n) => n.body.includes("you took ownership of the casino"))).toBe(true);
    // Seat 0 was paid in full, so nothing was seized on their behalf.
    const seatZeroNotes = await db.select().from(notifications)
      .where(eq(notifications.playerId, a.playerId));
    expect(seatZeroNotes.some((n) => n.body.includes("you took ownership of the casino"))).toBe(false);
  });

  it("answers 409 wrong_location on act, and leave works from another town", async () => {
    const W = 10_000n;
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    await seedHouse(locationId, ownerId, 200_000n);
    await placePlayer(ownerId, locationId, 10_000_000n);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, locationId, 1_000_000n);
    await placePlayer(b.playerId, locationId, 1_000_000n);
    const sitRes = await sit(a.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(b.token);

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "travelled");
    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);

    const before = await tableRow(tableId);
    expect(before?.turnSeat).toBe(0);

    const elsewhere = await seedLocation();
    await placePlayer(a.playerId, elsewhere, 1_000_000n);
    const aCash = await cashOf(a.playerId);

    const refused = await tableAct(a.token, "stand");
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe("wrong_location");

    // The hand is untouched.
    const after = await tableRow(tableId);
    expect(after?.phase).toBe("acting");
    expect(after?.turnSeat).toBe(0);
    expect(after?.state).toEqual(before?.state);
    expect(await cashOf(a.playerId)).toBe(aCash);

    // `leave` locks the SEAT's town, never the caller's, so it works from
    // anywhere — and an in-hand seat leaves with its stake still in play.
    const left = await leave(a.token);
    expect(left.statusCode).toBe(200);
    expect(left.json<{ left: boolean; deferred: boolean }>()).toEqual({ left: true, deferred: true });
    const seat = await seatRow(tableId, a.playerId);
    expect(seat?.leaving).toBe(true);
    expect(seat?.wager).toBe(W);
    expect(await cashOf(a.playerId)).toBe(aCash);
  });

  it("never sends the dealer's hole card to a seat still choosing", async () => {
    const W = 10_000n;
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    await seedHouse(locationId, ownerId, 200_000n);
    await placePlayer(ownerId, locationId, 10_000_000n);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, locationId, 1_000_000n);
    await placePlayer(b.playerId, locationId, 1_000_000n);
    const sitRes = await sit(a.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(b.token);

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    // The shoe is six decks, so a card CODE can repeat. Pick a deal whose
    // hole card appears nowhere else on the table, or "absent" would be
    // unprovable rather than false.
    const seed = probeSeed(bettors, (s) => {
      if (!s.hands.every((h) => h.phase === "playing")) return false;
      const hole = s.dealer[1]!;
      const shown = [s.dealer[0]!, ...s.hands.flatMap((h) => h.cards)];
      return !shown.includes(hole);
    }, "concealed");
    const dealtState = dealTable(bettors, seed);
    const hole = dealtState.dealer[1]!;

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);

    for (const token of [a.token, b.token]) {
      const res = await tableView(token);
      expect(res.statusCode).toBe(200);
      const cards = cardsIn(payloadOf(res.body)?.view);
      expect(cards.filter((c) => c === "B1")).toHaveLength(1);
      expect(cards).not.toContain(hole);
      expect(cards).toContain(dealtState.dealer[0]!);
    }
  });

  it("keeps a betting-phase leaver's escrowed stake in play — no money is ever dropped by leaving", async () => {
    const W = 10_000n;
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    await seedHouse(locationId, ownerId, 200_000n);
    await placePlayer(ownerId, locationId, 10_000_000n);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, locationId, 1_000_000n);
    await placePlayer(b.playerId, locationId, 1_000_000n);
    const sitRes = await sit(a.token);
    const { tableId } = sitRes.json<{ tableId: string }>();
    await sit(b.token);

    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    // Seat 0 (the leaver) naturals, so it never has a turn to take — the
    // seat plays out and settles without its player ever acting again.
    const seed = probeSeed(
      bettors,
      (s) => s.hands[0]!.phase === "natural" && s.hands[1]!.phase === "playing",
      "leaver",
    );
    const finalState = actSeat(dealTable(bettors, seed), 1, "stand").state;
    const payouts = new Map(settleTable(finalState).map((p) => [p.seat, p.payout]));
    const payoutA = payouts.get(0)!;

    const aCashBefore = await cashOf(a.playerId);
    const aLedgerBefore = await ledgerCashOf(a.playerId);

    // A bets and then leaves while the table is STILL in the betting phase.
    expect((await bet(a.token, W)).statusCode).toBe(200);
    expect((await tableRow(tableId))?.phase).toBe("betting");
    const left = await leave(a.token);
    expect(left.statusCode).toBe(200);
    expect(left.json<{ deferred: boolean }>().deferred).toBe(true);
    // Leaving moves no money: the stake stays escrowed with the house.
    expect(await cashOf(a.playerId)).toBe(aCashBefore - W);

    // B is the only NON-leaving seat, so B's bet completes the table and the
    // deal includes A's escrowed stake.
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);
    const dealtRow = await tableRow(tableId);
    expect(dealtRow?.phase).toBe("acting");
    expect(dealtRow?.turnSeat).toBe(1);

    expect((await tableAct(b.token, "stand")).statusCode).toBe(200);

    // A was paid exactly what the rules say, and A's seat is gone.
    expect(await cashOf(a.playerId)).toBe(aCashBefore - W + payoutA);
    expect(await ledgerCashOf(a.playerId)).toBe(aLedgerBefore - W + payoutA);
    expect(await seatRow(tableId, a.playerId)).toBeUndefined();

    const bSeat = await seatRow(tableId, b.playerId);
    expect(bSeat).toBeDefined();
    expect(bSeat?.wager).toBe(0n);
    const row = await tableRow(tableId);
    expect(row?.phase).toBe("betting");
    expect(row?.state).toBeNull();
  });
});
