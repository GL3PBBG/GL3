import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import casinoPlugin, { tableGames, type TableGameDef } from "@gl3/plugin-casino";
import propertiesPlugin from "@gl3/plugin-properties";
import { on, type PluginManifest } from "@gl3/plugin-sdk";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSeats, casinoTables } from "./helpers/plugin-tables.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

/**
 * `casino-rogue-game.test.ts`'s table twin — the same spec §11 risk-1 trust
 * boundary, exercised against `TableGameDef`. `resolveTablePayouts` and
 * `applyStep` (`table-engine.ts`) are the guards under test, from Tasks 10-11;
 * every hostile game below is a fixture, and a failure here is a hub defect,
 * not a fixture bug — see the diagnosis note before each fix, if any.
 *
 * Same rogue-id trick as the solo file: `buildTableRegistry` rejects a
 * `TableGameDef` whose id is not an installed plugin id, so the rogue's id is
 * `"casino"` and `callPluginRoute`'s installed set is the one manifest it is
 * given. No `bootTestServer()`, so this file runs casino's and properties'
 * migrations itself (CLAUDE.md), and a `PluginError` propagates to the caller
 * rather than becoming a status code — assert with `.rejects.toMatchObject`.
 *
 * Every scenario is an UNOWNED town: the clamp, the wagerDelta and the turn
 * guards are all bounds on the FIGURE the game hands back, not on who pays
 * it, so a sink/faucet house is the simplest fixture that proves them. The
 * bankruptcy-takeover path is `casino-table-money.test.ts`'s job, not this
 * file's.
 */
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `casino-rogue-table-${uuidv7()}`;

const WAGER = 10_000n;

/** A table game whose behaviour each test picks. Only the hub is under test.
 *  Defaults deal/act/autoAct to an honest single-seat step that keeps seat 0
 *  in the hand, so a test only needs to override the one handler it means to
 *  make hostile. */
function rogueTableGame(over: Partial<TableGameDef<unknown>>): TableGameDef<unknown> {
  const openStep = { state: { rogue: true }, done: false, turn: 0 };
  return {
    id: "casino",
    name: "Rogue Table",
    maxPayoutMultiplier: 2,
    action: z.unknown(),
    deal: () => openStep,
    act: () => openStep,
    autoAct: (state: unknown, seat: number) => ({ state, done: false, turn: seat }),
    view: () => ({ kind: "text", value: "rogue" }),
    settle: () => [],
    ...over,
  };
}

/** The real casino hub, with one table game subscribed to its own filter
 *  point — the same route a third-party game takes. */
function casinoWith(game: TableGameDef<unknown>): PluginManifest {
  return { ...casinoPlugin, filters: [on(tableGames, (_ctx, list) => [...list, game as TableGameDef])] };
}

async function seedLocation(): Promise<string> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `rogue-table-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  return locationId;
}

async function seedPlayer(locationId: string, cash: bigint): Promise<string> {
  const playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `rogue-${playerId.slice(-8)}` });
  await db.insert(playerStats).values({ playerId, cash, locationId });
  return playerId;
}

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

async function seatRow(tableId: string, playerId: string) {
  const [row] = await db.select().from(casinoSeats)
    .where(and(eq(casinoSeats.tableId, tableId), eq(casinoSeats.playerId, playerId)));
  return row;
}

/** Writes a PAST `deadline_at` directly — `casino-table-clock.test.ts`'s
 *  substitute for waiting on the real clock. */
async function backdate(tableId: string, secondsAgo: number): Promise<void> {
  await db.update(casinoTables).set({ deadlineAt: new Date(Date.now() - secondsAgo * 1000) })
    .where(eq(casinoTables.id, tableId));
}

function sit(manifest: PluginManifest, playerId: string) {
  return callPluginRoute(manifest, "POST", "/api/casino/table/sit", {
    db, redis, leaderboardPrefix, playerId, body: { gameId: "casino" },
  });
}

function bet(manifest: PluginManifest, playerId: string, wager: bigint) {
  return callPluginRoute(manifest, "POST", "/api/casino/table/bet", {
    db, redis, leaderboardPrefix, playerId, body: { wager: wager.toString() },
  });
}

function act(manifest: PluginManifest, playerId: string, action: unknown = "go") {
  return callPluginRoute(manifest, "POST", "/api/casino/table/act", {
    db, redis, leaderboardPrefix, playerId, body: { action },
  });
}

function leave(manifest: PluginManifest, playerId: string) {
  return callPluginRoute(manifest, "POST", "/api/casino/table/leave", {
    db, redis, leaderboardPrefix, playerId, body: {},
  });
}

function readTable(manifest: PluginManifest, playerId: string) {
  return callPluginRoute(manifest, "GET", "/api/casino/table", { db, redis, leaderboardPrefix, playerId });
}

const sitBody = z.object({ tableId: z.string(), seat: z.number() });

/** One player, seated alone at a fresh table. */
async function seatOne(
  manifest: PluginManifest, cash = 1_000_000n,
): Promise<{ playerId: string; locationId: string; tableId: string }> {
  const locationId = await seedLocation();
  const playerId = await seedPlayer(locationId, cash);
  const res = await sit(manifest, playerId);
  const body = sitBody.parse(res.body);
  return { playerId, locationId, tableId: body.tableId };
}

/** Two players, seated at the same table — seat 0 sits first. */
async function seatTwo(
  manifest: PluginManifest, cash = 1_000_000n,
): Promise<{ a: string; b: string; locationId: string; tableId: string }> {
  const locationId = await seedLocation();
  const a = await seedPlayer(locationId, cash);
  const b = await seedPlayer(locationId, cash);
  const resA = sitBody.parse((await sit(manifest, a)).body);
  const resB = sitBody.parse((await sit(manifest, b)).body);
  expect(resB.tableId).toBe(resA.tableId);
  return { a, b, locationId, tableId: resA.tableId };
}

beforeAll(async () => {
  await resetDb(db);
  await runPluginMigrations(db, [casinoPlugin, propertiesPlugin]);
});

afterAll(async () => {
  await redis.quit();
  await conn.end();
});

describe("a table game that returns more than it is entitled to", () => {
  it("clamps each seat independently to maxPayoutMultiplier × its own wager", async () => {
    const manifest = casinoWith(rogueTableGame({
      deal: () => ({ state: {}, done: true, turn: null }),
      settle: () => [{ seat: 0, payout: WAGER * 10n }, { seat: 1, payout: WAGER * 10n }],
    }));
    const { a, b, tableId } = await seatTwo(manifest);
    const aBefore = await cashOf(a);
    const bBefore = await cashOf(b);

    expect((await bet(manifest, a, WAGER)).status).toBe(200);
    // B's bet completes the table, so the deal — and the settle it declares
    // done immediately — fires inside this same call.
    expect((await bet(manifest, b, WAGER)).status).toBe(200);

    // Declared 10×, clamped to the declared maxPayoutMultiplier (2): net per
    // seat is +1× the wager, not +9×, and the two seats are bounded
    // INDEPENDENTLY rather than against the table's combined stake.
    expect(await cashOf(a)).toBe(aBefore + WAGER);
    expect(await cashOf(b)).toBe(bBefore + WAGER);
    expect((await seatRow(tableId, a))?.wager).toBe(0n);
    expect((await seatRow(tableId, b))?.wager).toBe(0n);
  });
});

describe("a table game that misdeclares its settle figures", () => {
  it("refuses a negative payout, and the whole hand rolls back", async () => {
    const manifest = casinoWith(rogueTableGame({
      deal: () => ({ state: {}, done: true, turn: null }),
      settle: () => [{ seat: 0, payout: -1n }],
    }));
    const { playerId } = await seatOne(manifest);
    const before = await cashOf(playerId);

    // The bet call is what triggers the deal (single seat, ready immediately)
    // and the settle inside it — the escrow taken by this SAME call is what
    // must roll back too.
    await expect(bet(manifest, playerId, WAGER)).rejects.toMatchObject({ code: "invalid_payout" });
    expect(await cashOf(playerId)).toBe(before);
  });

  it("refuses a payout naming a seat that is not in the hand", async () => {
    const manifest = casinoWith(rogueTableGame({
      deal: () => ({ state: {}, done: true, turn: null }),
      settle: () => [{ seat: 5, payout: WAGER }],
    }));
    const { playerId } = await seatOne(manifest);
    const before = await cashOf(playerId);

    await expect(bet(manifest, playerId, WAGER)).rejects.toMatchObject({ code: "invalid_payout" });
    expect(await cashOf(playerId)).toBe(before);
  });

  it("refuses a payout naming the same seat twice", async () => {
    const manifest = casinoWith(rogueTableGame({
      deal: () => ({ state: {}, done: true, turn: null }),
      settle: () => [{ seat: 0, payout: 0n }, { seat: 0, payout: 0n }],
    }));
    const { playerId } = await seatOne(manifest);
    const before = await cashOf(playerId);

    await expect(bet(manifest, playerId, WAGER)).rejects.toMatchObject({ code: "invalid_payout" });
    expect(await cashOf(playerId)).toBe(before);
  });
});

describe("a table game that raises the wager on the wrong seat, or by a negative amount", () => {
  it("refuses a wagerDelta naming a seat other than the one that acted", async () => {
    // TWO seats, both real and in-hand: naming seat 1 must be refused because
    // it is not the ACTOR (seat 0), not merely because seat 1 doesn't exist.
    // A single-seat fixture here would be vacuous — `applyStep`'s fallback
    // lookup (`seats.find(...)` returning `undefined`) throws the same code
    // for a seat that is simply absent, which proves nothing about the
    // `delta.seat !== actingSeat` clause specifically.
    const manifest = casinoWith(rogueTableGame({
      act: () => ({ state: {}, done: false, turn: 0, wagerDelta: { seat: 1, amount: 5_000n } }),
    }));
    const { a, b, tableId } = await seatTwo(manifest);
    expect((await bet(manifest, a, WAGER)).status).toBe(200);
    // B's bet completes the table — the deal fires here, turnSeat lands on
    // seat 0 (a), and seat 1 (b) is a real, in-hand seat with its own wager.
    expect((await bet(manifest, b, WAGER)).status).toBe(200);

    await expect(act(manifest, a)).rejects.toMatchObject({ code: "invalid_wager_delta" });
    expect((await seatRow(tableId, a))?.wager).toBe(WAGER);
    expect((await seatRow(tableId, b))?.wager).toBe(WAGER);
  });

  it("refuses a negative wagerDelta even from the acting seat", async () => {
    const manifest = casinoWith(rogueTableGame({
      act: () => ({ state: {}, done: false, turn: 0, wagerDelta: { seat: 0, amount: -5_000n } }),
    }));
    const { playerId, tableId } = await seatOne(manifest);
    expect((await bet(manifest, playerId, WAGER)).status).toBe(200);

    await expect(act(manifest, playerId)).rejects.toMatchObject({ code: "invalid_wager_delta" });
    expect((await seatRow(tableId, playerId))?.wager).toBe(WAGER);
  });
});

describe("a table game whose autoAct raises the wager", () => {
  it("refuses the wagerDelta when the clock fires — the clock can never raise an absent seat's stake", async () => {
    const manifest = casinoWith(rogueTableGame({
      autoAct: (state: unknown, seat: number) =>
        ({ state, done: false, turn: seat, wagerDelta: { seat, amount: 5_000n } }),
    }));
    const { playerId, tableId } = await seatOne(manifest);
    expect((await bet(manifest, playerId, WAGER)).status).toBe(200);
    await backdate(tableId, 1);

    // A GET runs the clock — `actingSeat` is null for every autoAct step, so
    // this throws regardless of the seat the rogue game names.
    await expect(readTable(manifest, playerId)).rejects.toMatchObject({ code: "invalid_wager_delta" });
    expect((await seatRow(tableId, playerId))?.wager).toBe(WAGER);
  });
});

describe("a table game that throws", () => {
  it("becomes a clean error from deal", async () => {
    const manifest = casinoWith(rogueTableGame({
      deal: () => { throw new Error("dealer walked off"); },
    }));
    const { playerId } = await seatOne(manifest);
    const before = await cashOf(playerId);

    await expect(bet(manifest, playerId, WAGER)).rejects.toMatchObject({ code: "game_error" });
    // The deal never happened, so the bet that triggered it rolled back too.
    expect(await cashOf(playerId)).toBe(before);
  });

  it("becomes a clean error from act", async () => {
    const manifest = casinoWith(rogueTableGame({
      act: () => { throw new Error("no such move"); },
    }));
    const { playerId } = await seatOne(manifest);
    expect((await bet(manifest, playerId, WAGER)).status).toBe(200);

    await expect(act(manifest, playerId)).rejects.toMatchObject({ code: "game_error" });
  });
});

describe("a table game whose step points the turn at a seat that is not in the hand", () => {
  it("refuses with invalid_turn", async () => {
    const manifest = casinoWith(rogueTableGame({
      act: () => ({ state: {}, done: false, turn: 99 }),
    }));
    const { playerId } = await seatOne(manifest);
    expect((await bet(manifest, playerId, WAGER)).status).toBe(200);

    await expect(act(manifest, playerId)).rejects.toMatchObject({ code: "invalid_turn" });
  });
});

describe("a table game whose autoAct never advances the turn", () => {
  it("exhausts advanceTable's bound and the read 500s — loud by design — while the wager-0 escape hatch still works", async () => {
    // `autoAct` hands back the SAME turn every time: a valid seat, still in
    // the hand, `done: false`. `advanceTable`'s loop is bounded at
    // `3 * MAX_TABLE_SEATS` passes precisely against a game like this one, so
    // a badly-overdue table never spins forever — it 500s instead. This is
    // the controller ruling this file pins: LOUD by design, not a crash to
    // patch over, because the alternative is an unbounded loop on every read
    // any player at the table ever makes.
    const manifest = casinoWith(rogueTableGame({}));
    const { playerId, locationId, tableId } = await seatOne(manifest);
    expect((await bet(manifest, playerId, WAGER)).status).toBe(200);
    const cashAfterBet = await cashOf(playerId);
    const wagerAfterBet = (await seatRow(tableId, playerId))?.wager;
    expect(wagerAfterBet).toBe(WAGER);

    // Badly overdue: even after `advanceTable` advances the deadline by
    // `table_turn_seconds` (30s) on every one of its 15 bounded passes — 450s
    // of ground covered — the deadline is still comfortably in the past.
    await backdate(tableId, 3_600);

    // A second seat that holds no stake, at the SAME stuck table. Inserted
    // directly rather than through `sit`: `sit`'s existing-table branch also
    // calls `advanceTable`, so joining this table through the route would hit
    // the very defect this test is about before the seat could ever exist.
    const bystander = await seedPlayer(locationId, 1_000_000n);
    await db.insert(casinoSeats).values({ id: uuidv7(), tableId, playerId: bystander, seatNo: 1 });

    // THE READ. 500-class, same PluginError class as invalid_wager_delta —
    // loud, not a crash: the caller gets a clean error object, never an
    // unhandled exception.
    await expect(readTable(manifest, playerId)).rejects.toMatchObject({ code: "invalid_turn", status: 500 });

    // Money unmoved: the failed read's transaction rolled back every write
    // any of its bounded passes made, so the table is exactly where the
    // committed `bet` call left it — the wager still escrowed (with the
    // house, an unowned-town sink here) and not returned, because no hand
    // ever actually settled.
    expect(await cashOf(playerId)).toBe(cashAfterBet);
    expect((await seatRow(tableId, playerId))?.wager).toBe(WAGER);

    // THE ESCAPE HATCH (Task 11): a seat with no stake needs neither the
    // clock nor the game to leave — `leave`'s wager-0 fast exit never calls
    // `advanceTable`, so a table this broken still lets a stakeless bystander
    // walk away.
    const left = await leave(manifest, bystander);
    expect(left.body).toEqual({ left: true, deferred: false });
    expect(await seatRow(tableId, bystander)).toBeUndefined();
  });
});
