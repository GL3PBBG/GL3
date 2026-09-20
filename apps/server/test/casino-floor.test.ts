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
 * The casino floor's geometry (spec 2026-09-20 casino-interior §5.1) and the
 * `station` column that binds a live table row to one of its four
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

describe("CASINO_FLOOR (spec §5.1)", () => {
  it("is the spec's geometry: four blackjack stations 0..3, five seats each, all inside bounds", () => {
    expect(InteriorDeclSchema.parse(CASINO_FLOOR).sceneKey).toBe("casino-floor-v1");
    expect(CASINO_FLOOR.bounds).toEqual({ minX: -12, minY: -9, maxX: 12, maxY: 9 });
    expect(CASINO_FLOOR.spawn).toEqual({ x: 0, y: -7.5, facing: 0 });
    expect(CASINO_FLOOR.points.map((p) => [p.id, p.binding?.station, p.position])).toEqual([
      ["blackjack-1", 0, { x: -6, y: 3 }], ["blackjack-2", 1, { x: 6, y: 3 }],
      ["blackjack-3", 2, { x: -6, y: -3 }], ["blackjack-4", 3, { x: 6, y: -3 }],
    ]);
    for (const p of CASINO_FLOOR.points) {
      expect(p.kind).toBe("table"); expect(p.facing).toBe(Math.PI); expect(p.seats?.length).toBe(5);
      for (const s of p.seats!) { expect(s.x).toBeGreaterThanOrEqual(-12); expect(s.x).toBeLessThanOrEqual(12); expect(s.y).toBeGreaterThanOrEqual(-9); expect(s.y).toBeLessThanOrEqual(9); }
    }
    expect(stationsFor("blackjack")).toEqual([0, 1, 2, 3]);
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

describe("POST /api/casino/table/sit with a station (spec §5.3)", () => {
  it("opens a table at the named station and a second sitter joins it", async () => {
    const locationId = await seedLocation();
    const a = await register(); await placePlayer(a.playerId, locationId, 1_000_000n);
    const b = await register(); await placePlayer(b.playerId, locationId, 1_000_000n);
    const first = CasinoSitResponseSchema.parse((await sit(a.token, "blackjack", 2)).json());
    expect(first).toMatchObject({ seat: 0, station: 2 });
    const second = CasinoSitResponseSchema.parse((await sit(b.token, "blackjack", 2)).json());
    expect(second).toMatchObject({ tableId: first.tableId, seat: 1, station: 2 });
    const view = CasinoTableResponseSchema.parse((await tableView(a.token)).json());
    expect(view.table?.station).toBe(2);
  });
  it("400s unknown_station for a station the floor does not declare", async () => {
    const locationId = await seedLocation();
    const a = await register(); await placePlayer(a.playerId, locationId, 1_000_000n);
    const res = await sit(a.token, "blackjack", 4);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_station" });
  });
  it("a sit without a station takes the lowest free one, and NULL once all four are live", async () => {
    const locationId = await seedLocation();
    const stations: (number | null)[] = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await register(); await placePlayer(p.playerId, locationId, 1_000_000n);
      // Every sitter opens a NEW table: fill each one first so the selection cannot re-use it.
      const res = CasinoSitResponseSchema.parse((await sit(p.token, "blackjack", i < 4 ? i : undefined)).json());
      stations.push(res.station ?? null);
    }
    expect(stations.slice(0, 4)).toEqual([0, 1, 2, 3]);
    // The fifth sitter joined station 0's table (first table with a free seat), so:
    expect(stations[4]).toBe(0);
  });
  it("a fresh table with no station given lands on the lowest free station, and off-floor when none is free", async () => {
    const locationId = await seedLocation();
    for (const st of [0, 1, 3]) {
      const p = await register(); await placePlayer(p.playerId, locationId, 1_000_000n);
      await sit(p.token, "blackjack", st);
    }
    // Fill those three tables so a plain sit must open a new one.
    for (const st of [0, 1, 3]) for (let k = 0; k < 4; k += 1) {
      const p = await register(); await placePlayer(p.playerId, locationId, 1_000_000n);
      expect((await sit(p.token, "blackjack", st)).statusCode).toBe(200);
    }
    // A NAMED station whose table is full is a refusal, not a new table.
    const overflow = await register(); await placePlayer(overflow.playerId, locationId, 1_000_000n);
    const full = await sit(overflow.token, "blackjack", 3);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: "table_full" });
    const p = await register(); await placePlayer(p.playerId, locationId, 1_000_000n);
    expect(CasinoSitResponseSchema.parse((await sit(p.token)).json()).station).toBe(2);
    for (let k = 0; k < 4; k += 1) { const q = await register(); await placePlayer(q.playerId, locationId, 1_000_000n); await sit(q.token, "blackjack", 2); }
    const last = await register(); await placePlayer(last.playerId, locationId, 1_000_000n);
    expect(CasinoSitResponseSchema.parse((await sit(last.token)).json()).station).toBeNull();
    const lobbyBody = CasinoLobbyResponseSchema.parse((await lobby(last.token)).json());
    expect(lobbyBody.tableGames.find((g) => g.gameId === "blackjack")?.tables.map((t) => t.station).sort()).toEqual([0, 1, 2, 3, null].sort());
  });
});

describe("GET /api/casino/floor (spec §5.3)", () => {
  it("lists every declared station in order with its live table, seats and names", async () => {
    const locationId = await seedLocation();
    const a = await register(); await placePlayer(a.playerId, locationId, 1_000_000n);
    const b = await register(); await placePlayer(b.playerId, locationId, 1_000_000n);
    const opened = CasinoSitResponseSchema.parse((await sit(a.token, "blackjack", 1)).json());
    await sit(b.token, "blackjack", 1);
    const body = CasinoFloorResponseSchema.parse((await floor(a.token)).json());
    expect(body.locationId).toBe(locationId);
    expect(body.combatMode).toBe("open");
    expect(body.stations.map((s) => [s.station, s.gameId, s.available, s.tableId])).toEqual([
      [0, "blackjack", true, null], [1, "blackjack", true, opened.tableId], [2, "blackjack", true, null], [3, "blackjack", true, null],
    ]);
    expect(body.stations[1]).toMatchObject({ phase: "betting", seatsFilled: 2, maxSeats: 5 });
    expect(body.stations[1]!.seats.map((s) => [s.seat, s.playerId, s.username])).toEqual([[0, a.playerId, a.username], [1, b.playerId, b.username]]);
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
