import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASINO_FLOOR, stationsFor, tableSeats } from "@gl3/plugin-casino";
import {
  CasinoFloorResponseSchema, CasinoLobbyResponseSchema, CasinoSitResponseSchema, CasinoTableResponseSchema,
  InteriorDeclSchema,
} from "@gl3/shared";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoTables } from "./helpers/plugin-tables.js";
import { pgErrorConstraint, rejectionOf } from "./helpers/pg-error.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The casino floor's geometry (spec 2026-09-21 casino-floor-v2) and the
 * `station` column that binds a live table row to one of blackjack's own
 * stations (spec §5.2). Boots plain `bootTestServer()` — no extra plugins,
 * unlike `casino-tables.test.ts`, which adds `keno` for the lobby listing.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Floorer${regCounter}`,
    remoteAddress: `10.62.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
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

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats).set({ locationId, cash }).where(eq(playerStats.playerId, playerId));
}

function sit(token: string, gameId = "blackjack", station?: number) {
  return app.inject({
    method: "POST", url: "/api/casino/table/sit",
    headers: { authorization: `Bearer ${token}` },
    payload: { gameId, ...(station === undefined ? {} : { station }) },
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

function lobby(token: string) {
  return app.inject({
    method: "GET", url: "/api/casino",
    headers: { authorization: `Bearer ${token}` },
  });
}

function floor(token: string) {
  return app.inject({
    method: "GET", url: "/api/casino/floor",
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("CASINO_FLOOR (spec 2026-09-21 casino-floor-v2)", () => {
  it("is the v2 geometry: one blackjack table, one hold'em table, eight slot machines, all inside bounds", () => {
    expect(InteriorDeclSchema.parse(CASINO_FLOOR).sceneKey).toBe("casino-floor-v2");
    expect(CASINO_FLOOR.bounds).toEqual({ minX: -12, minY: -9, maxX: 12, maxY: 9 });
    expect(CASINO_FLOOR.spawn).toEqual({ x: 0, y: -7.5, facing: 0 });
    expect(CASINO_FLOOR.points.map((p) => [p.id, p.kind, p.binding, p.position])).toEqual([
      ["blackjack-1", "table", { gameId: "blackjack", station: 0 }, { x: -6, y: 1 }],
      ["holdem-1", "table", { gameId: "holdem", station: 0 }, { x: 6, y: 1 }],
      ["slots-1", "machine", { gameId: "slots", station: 0 }, { x: -10.5, y: 7.5 }],
      ["slots-2", "machine", { gameId: "slots", station: 1 }, { x: -7.5, y: 7.5 }],
      ["slots-3", "machine", { gameId: "slots", station: 2 }, { x: -4.5, y: 7.5 }],
      ["slots-4", "machine", { gameId: "slots", station: 3 }, { x: -1.5, y: 7.5 }],
      ["slots-5", "machine", { gameId: "slots", station: 4 }, { x: 1.5, y: 7.5 }],
      ["slots-6", "machine", { gameId: "slots", station: 5 }, { x: 4.5, y: 7.5 }],
      ["slots-7", "machine", { gameId: "slots", station: 6 }, { x: 7.5, y: 7.5 }],
      ["slots-8", "machine", { gameId: "slots", station: 7 }, { x: 10.5, y: 7.5 }],
    ]);
    for (const p of CASINO_FLOOR.points) {
      expect(p.facing).toBe(Math.PI);
      expect(p.position.x).toBeGreaterThanOrEqual(-12); expect(p.position.x).toBeLessThanOrEqual(12);
      expect(p.position.y).toBeGreaterThanOrEqual(-9); expect(p.position.y).toBeLessThanOrEqual(9);
      for (const s of p.seats!) { expect(s.x).toBeGreaterThanOrEqual(-12); expect(s.x).toBeLessThanOrEqual(12); expect(s.y).toBeGreaterThanOrEqual(-9); expect(s.y).toBeLessThanOrEqual(9); }
    }
    const [bj, hd] = CASINO_FLOOR.points;
    expect(bj!.seats?.length).toBe(5); expect(hd!.seats?.length).toBe(5);
    for (const m of CASINO_FLOOR.points.slice(2)) {
      expect(m.seats).toEqual([{ x: m.position.x, y: 6, facing: 0 }]);
    }
    expect(stationsFor("blackjack")).toEqual([0]);
    expect(stationsFor("holdem")).toEqual([0]);
    expect(stationsFor("slots")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(stationsFor("keno")).toEqual([]);
  });
  it("seats face the table centre", () => {
    const seats = tableSeats({ x: 0, y: 0 });
    expect(seats[2]).toEqual({ x: 0, y: -2, facing: 0 });
    expect(seats[0]!.facing).toBeCloseTo(-1.107, 3);
    expect(seats[4]!.facing).toBeCloseTo(1.107, 3);
  });
});

describe("p_casino_tables.station (spec §5.2)", () => {
  it("is nullable and unique per (location, game, station)", async () => {
    const locationId = await seedLocation();
    const mk = (station: number | null) => db.insert(casinoTables).values({ id: uuidv7(), gameId: "blackjack", locationId, seed: "s", station });
    await mk(null); await mk(null); await mk(0);
    // Not `.rejects.toThrow(regex)`: drizzle wraps the driver error, so
    // `.message` is only "Failed query: ..." — the constraint name lives on
    // `.cause` (see `helpers/pg-error.ts`).
    const error = await rejectionOf(mk(0));
    expect(pgErrorConstraint(error)).toBe("p_casino_tables_station");
  });
});

describe("POST /api/casino/table/sit with a station (spec 2026-09-21 casino-floor-v2)", () => {
  it("opens a table at the named station and a second sitter joins it", async () => {
    const locationId = await seedLocation();
    const a = await register(); await placePlayer(a.playerId, locationId, 1_000_000n);
    const b = await register(); await placePlayer(b.playerId, locationId, 1_000_000n);
    const first = CasinoSitResponseSchema.parse((await sit(a.token, "blackjack", 0)).json());
    expect(first).toMatchObject({ seat: 0, station: 0 });
    const second = CasinoSitResponseSchema.parse((await sit(b.token, "blackjack", 0)).json());
    expect(second).toMatchObject({ tableId: first.tableId, seat: 1, station: 0 });
    const view = CasinoTableResponseSchema.parse((await tableView(a.token)).json());
    expect(view.table?.station).toBe(0);
  });
  it("400s unknown_station for a station the floor does not declare — blackjack has only station 0", async () => {
    const locationId = await seedLocation();
    const a = await register(); await placePlayer(a.playerId, locationId, 1_000_000n);
    const res = await sit(a.token, "blackjack", 1);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_station" });
  });
  it("a plain sit takes station 0; once it is full, a named sit 409s and a plain sit opens an off-floor table", async () => {
    const locationId = await seedLocation();
    const first = await register(); await placePlayer(first.playerId, locationId, 1_000_000n);
    expect(CasinoSitResponseSchema.parse((await sit(first.token)).json())).toMatchObject({ seat: 0, station: 0 });
    // Fill the table to five seats.
    for (let k = 1; k < 5; k += 1) {
      const p = await register(); await placePlayer(p.playerId, locationId, 1_000_000n);
      expect(CasinoSitResponseSchema.parse((await sit(p.token, "blackjack", 0)).json())).toMatchObject({ seat: k, station: 0 });
    }
    // A sixth NAMED sit at the full station is a refusal, not a new table.
    const overflowNamed = await register(); await placePlayer(overflowNamed.playerId, locationId, 1_000_000n);
    const full = await sit(overflowNamed.token, "blackjack", 0);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: "table_full" });
    // A sixth PLAIN sit opens a new table off the floor (`station: null` — the only declared station is taken).
    const overflowPlain = await register(); await placePlayer(overflowPlain.playerId, locationId, 1_000_000n);
    const offFloor = CasinoSitResponseSchema.parse((await sit(overflowPlain.token)).json());
    expect(offFloor.station).toBeNull();
    const lobbyBody = CasinoLobbyResponseSchema.parse((await lobby(overflowPlain.token)).json());
    expect(lobbyBody.tableGames.find((g) => g.gameId === "blackjack")?.tables.map((t) => t.station).sort()).toEqual([0, null].sort());
  });
});

describe("GET /api/casino/floor (spec 2026-09-21 casino-floor-v2)", () => {
  it("lists every declared station in declaration order (blackjack, hold'em, slots 0..7) with the live table, seats and names", async () => {
    const locationId = await seedLocation();
    const a = await register(); await placePlayer(a.playerId, locationId, 1_000_000n);
    const b = await register(); await placePlayer(b.playerId, locationId, 1_000_000n);
    const opened = CasinoSitResponseSchema.parse((await sit(a.token, "blackjack", 0)).json());
    await sit(b.token, "blackjack", 0);
    const body = CasinoFloorResponseSchema.parse((await floor(a.token)).json());
    expect(body.locationId).toBe(locationId);
    expect(body.combatMode).toBe("open");
    expect(body.stations.map((s) => [s.gameId, s.station, s.available, s.tableId])).toEqual([
      ["blackjack", 0, true, opened.tableId],
      ["holdem", 0, false, null],
      ["slots", 0, false, null], ["slots", 1, false, null], ["slots", 2, false, null], ["slots", 3, false, null],
      ["slots", 4, false, null], ["slots", 5, false, null], ["slots", 6, false, null], ["slots", 7, false, null],
    ]);
    expect(body.stations[0]).toMatchObject({ phase: "betting", seatsFilled: 2, maxSeats: 5 });
    expect(body.stations[0]!.seats.map((s) => [s.seat, s.playerId, s.username])).toEqual([[0, a.playerId, a.username], [1, b.playerId, b.username]]);
    for (const s of body.stations.slice(1)) expect(s).toMatchObject({ tableId: null, phase: null, seatsFilled: 0, seats: [] });
  });
  it("hides names in an underground town", async () => {
    const locationId = await seedLocation();
    await db.update(locations).set({ combatMode: "underground" }).where(eq(locations.id, locationId));
    const a = await register(); await placePlayer(a.playerId, locationId, 1_000_000n);
    await sit(a.token, "blackjack", 0);
    const body = CasinoFloorResponseSchema.parse((await floor(a.token)).json());
    expect(body.combatMode).toBe("underground");
    expect(body.stations[0]).toMatchObject({ seatsFilled: 1, seats: [] });
  });
  it("409s no_location for a player nowhere and is jail-gated", async () => {
    const a = await register();
    expect((await floor(a.token)).statusCode).toBe(409);
    const locationId = await seedLocation();
    await placePlayer(a.playerId, locationId, 0n);
    await db.update(playerStats).set({ jailedUntil: new Date(Date.now() + 60_000) }).where(eq(playerStats.playerId, a.playerId));
    expect((await floor(a.token)).statusCode).toBe(423);
  });
});
