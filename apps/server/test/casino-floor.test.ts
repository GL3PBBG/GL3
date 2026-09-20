import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASINO_FLOOR, stationsFor, tableSeats } from "@gl3/plugin-casino";
import { InteriorDeclSchema } from "@gl3/shared";
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
