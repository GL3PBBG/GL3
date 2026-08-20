import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { definePlugin, on, type PluginManifest } from "@gl3/plugin-sdk";
import { CasinoLobbyResponseSchema, CasinoTableResponseSchema } from "@gl3/shared";
import { tableGames, type TableGameDef } from "@gl3/plugin-casino";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSeats, casinoTables, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * A second table game, installed ALONGSIDE blackjack for this file only, so
 * the lobby's `tableGames` listing has something to show with no live table
 * — blackjack itself always has at least the sitters a given test seats.
 * Its three action methods are unreachable: nothing in this file ever sits
 * at it.
 */
const KENO_TABLE: TableGameDef = {
  id: "keno",
  name: "Keno",
  maxPayoutMultiplier: 2,
  action: z.unknown(),
  deal() { throw new Error("KENO_TABLE.deal must not be reached"); },
  act() { throw new Error("KENO_TABLE.act must not be reached"); },
  autoAct() { throw new Error("KENO_TABLE.autoAct must not be reached"); },
  view: () => ({ kind: "text", value: "keno" }),
  settle: () => [],
};

const kenoPlugin: PluginManifest = definePlugin({
  id: "keno",
  version: "1.0.0",
  basePaths: ["/api/keno"],
  filters: [on(tableGames, (_ctx, list) => [...list, KENO_TABLE])],
});

/**
 * POST/GET /api/casino/table/* — the hub's sit/leave/read routes — plus the
 * lobby's table listings (`GET /api/casino`, Task 12).
 *
 * Runs against `bootTestServer({ plugins: [kenoPlugin] })`: `casino` and
 * `blackjack` are both CORE_PLUGIN entries (`core-plugins.ts`), and
 * blackjack is now a table game (`BLACKJACK_TABLE`, registered via the
 * `casino.tableGames` filter point), so no explicit plugin list or migration
 * call is needed for either — the same shape as `casino-boot.test.ts`. `keno`
 * is added on top so the lobby has a second registered table game to show
 * empty.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Sitter${regCounter}`,
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

/** `cost` is the owner's lever (V2 blackjack.inc.php:276); 0n means unset. */
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

function lobby(token: string) {
  return app.inject({
    method: "GET", url: "/api/casino",
    headers: { authorization: `Bearer ${token}` },
  });
}

interface LobbyTableRow { tableId: string; seatsFilled: number; maxSeats: number; phase: string }
interface LobbyTableGame {
  gameId: string; name: string; ownerName: string | null; maxBet: string;
  maxSeats: number; tables: LobbyTableRow[];
}
interface LobbyRemoteRow {
  locationId: string; locationName: string; gameId: string; gameName: string; seated: number;
}
interface LobbyBody { tableGames: LobbyTableGame[]; remote: LobbyRemoteRow[] }

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [kenoPlugin] }));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("POST /api/casino/table/sit", () => {
  it("seats the caller at a fresh table in their town", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    const res = await sit(token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tableId: string; seat: number }>();
    expect(body.seat).toBe(0);

    const [table] = await db.select().from(casinoTables).where(eq(casinoTables.id, body.tableId));
    expect(table?.locationId).toBe(locationId);
    expect(table?.gameId).toBe("blackjack");
    expect(table?.phase).toBe("betting");

    const [seat] = await db.select().from(casinoSeats)
      .where(and(eq(casinoSeats.tableId, body.tableId), eq(casinoSeats.playerId, playerId)));
    expect(seat?.seatNo).toBe(0);
  });

  it("fills seats in order and the sixth sitter opens a second table", async () => {
    const locationId = await seedLocation();
    const players: { token: string; playerId: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { token, playerId } = await register();
      await placePlayer(playerId, locationId, 1_000_000n);
      players.push({ token, playerId });
    }

    let firstTableId: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const res = await sit(players[i]!.token);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ tableId: string; seat: number }>();
      expect(body.seat).toBe(i);
      if (firstTableId === null) firstTableId = body.tableId;
      expect(body.tableId).toBe(firstTableId);
    }

    const { token: sixthToken, playerId: sixthId } = await register();
    await placePlayer(sixthId, locationId, 1_000_000n);
    const res = await sit(sixthToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tableId: string; seat: number }>();
    expect(body.tableId).not.toBe(firstTableId);
    expect(body.seat).toBe(0);
  });

  it("re-uses the lowest freed seat number", async () => {
    const locationId = await seedLocation();
    const { token: tokenA, playerId: idA } = await register();
    const { token: tokenB, playerId: idB } = await register();
    const { token: tokenC, playerId: idC } = await register();
    await placePlayer(idA, locationId, 1_000_000n);
    await placePlayer(idB, locationId, 1_000_000n);
    await placePlayer(idC, locationId, 1_000_000n);

    const resA = await sit(tokenA);
    const resB = await sit(tokenB);
    expect(resA.json<{ seat: number }>().seat).toBe(0);
    expect(resB.json<{ seat: number }>().seat).toBe(1);

    const leaveRes = await leave(tokenA);
    expect(leaveRes.statusCode).toBe(200);

    const resC = await sit(tokenC);
    expect(resC.statusCode).toBe(200);
    expect(resC.json<{ seat: number }>().seat).toBe(0);
  });

  it("refuses a second seat anywhere with 409 already_seated", async () => {
    const locationId = await seedLocation();
    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);

    const first = await sit(token);
    expect(first.statusCode).toBe(200);

    const second = await sit(token);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe("already_seated");

    // Travelling away does not free the seat game-wide.
    const elsewhere = await seedLocation();
    await placePlayer(playerId, elsewhere, 1_000_000n);
    const third = await sit(token);
    expect(third.statusCode).toBe(409);
    expect(third.json<{ error: string }>().error).toBe("already_seated");
  });

  it("404s an unknown game and 409s a caller with no location", async () => {
    const locationId = await seedLocation();
    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);

    const unknownGame = await sit(token, "roulette");
    expect(unknownGame.statusCode).toBe(404);
    expect(unknownGame.json<{ error: string }>().error).toBe("no_such_game");

    const { token: nowhereToken } = await register();
    const noLocation = await sit(nowhereToken);
    expect(noLocation.statusCode).toBe(409);
    expect(noLocation.json<{ error: string }>().error).toBe("no_location");
  });

  it("stamps the frozen house at table creation", async () => {
    const locationId = await seedLocation();
    const { playerId: ownerId } = await register();
    const propertyId = await seedHouse(locationId, ownerId, 50_000n);

    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);

    const res = await sit(token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tableId: string }>();

    const [table] = await db.select().from(casinoTables).where(eq(casinoTables.id, body.tableId));
    expect(table?.propertyId).toBe(propertyId);
  });
});

describe("POST /api/casino/table/leave", () => {
  it("frees a betting-phase seat immediately and deletes an emptied table", async () => {
    const locationId = await seedLocation();
    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);

    const sitRes = await sit(token);
    const { tableId } = sitRes.json<{ tableId: string }>();

    const leaveRes = await leave(token);
    expect(leaveRes.statusCode).toBe(200);
    expect(leaveRes.json<{ left: boolean; deferred: boolean }>()).toEqual({ left: true, deferred: false });

    const seats = await db.select().from(casinoSeats)
      .where(and(eq(casinoSeats.tableId, tableId), eq(casinoSeats.playerId, playerId)));
    expect(seats).toHaveLength(0);

    const [table] = await db.select().from(casinoTables).where(eq(casinoTables.id, tableId));
    expect(table).toBeUndefined();
  });

  it("keeps the table when other seats remain", async () => {
    const locationId = await seedLocation();
    const { token: tokenA, playerId: idA } = await register();
    const { token: tokenB, playerId: idB } = await register();
    await placePlayer(idA, locationId, 1_000_000n);
    await placePlayer(idB, locationId, 1_000_000n);

    const sitA = await sit(tokenA);
    const { tableId } = sitA.json<{ tableId: string }>();
    await sit(tokenB);

    const leaveRes = await leave(tokenA);
    expect(leaveRes.statusCode).toBe(200);
    expect(leaveRes.json<{ deferred: boolean }>().deferred).toBe(false);

    const [table] = await db.select().from(casinoTables).where(eq(casinoTables.id, tableId));
    expect(table).toBeDefined();

    const remaining = await db.select().from(casinoSeats).where(eq(casinoSeats.tableId, tableId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.playerId).toBe(idB);
  });
});

describe("GET /api/casino/table", () => {
  it("answers { table: null } for the unseated", async () => {
    const { token } = await register();
    const res = await tableView(token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ table: null }>()).toEqual({ table: null });
  });

  it("shows phase, seats with usernames, and no view between hands", async () => {
    const locationId = await seedLocation();
    const { token: tokenA, playerId: idA, username: usernameA } = await register();
    const { token: tokenB, playerId: idB, username: usernameB } = await register();
    await placePlayer(idA, locationId, 1_000_000n);
    await placePlayer(idB, locationId, 1_000_000n);

    const sitA = await sit(tokenA);
    const { seat: seatA } = sitA.json<{ seat: number }>();
    await sit(tokenB);

    const res = await tableView(tokenA);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      table: {
        phase: string; view: unknown; mySeat: number | null;
        seats: { seat: number; username: string }[];
      } | null;
    }>();
    expect(body.table).not.toBeNull();
    expect(body.table?.phase).toBe("betting");
    expect(body.table?.view).toBeNull();
    expect(body.table?.mySeat).toBe(seatA);
    expect(body.table?.seats).toHaveLength(2);
    const usernames = body.table?.seats.map((s) => s.username).sort();
    expect(usernames).toEqual([usernameA, usernameB].sort());
  });
});

describe("GET /api/casino table listings", () => {
  it("lists the town's tables with fill counts and the game's house", async () => {
    const locationId = await seedLocation();
    const { playerId: ownerId, username: ownerName } = await register();
    await seedHouse(locationId, ownerId, 50_000n);

    const { token: tokenA, playerId: idA } = await register();
    const { token: tokenB, playerId: idB } = await register();
    await placePlayer(idA, locationId, 1_000_000n);
    await placePlayer(idB, locationId, 1_000_000n);
    const sitA = await sit(tokenA);
    const { tableId } = sitA.json<{ tableId: string }>();
    await sit(tokenB);

    const { token: callerToken, playerId: callerId } = await register();
    await placePlayer(callerId, locationId, 1_000_000n);

    const res = await lobby(callerToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<LobbyBody>();

    const blackjackRow = body.tableGames.find((g) => g.gameId === "blackjack");
    expect(blackjackRow).toBeDefined();
    expect(blackjackRow?.ownerName).toBe(ownerName);
    // The owner's lever IS the maximum bet (V2 blackjack.inc.php:276).
    expect(blackjackRow?.maxBet).toBe("50000");
    expect(blackjackRow?.maxSeats).toBe(5);
    expect(blackjackRow?.tables).toEqual([
      { tableId, seatsFilled: 2, maxSeats: 5, phase: "betting" },
    ]);

    // A registered table game with NO live table still appears, tables: [].
    const kenoRow = body.tableGames.find((g) => g.gameId === "keno");
    expect(kenoRow).toBeDefined();
    expect(kenoRow?.name).toBe("Keno");
    expect(kenoRow?.tables).toEqual([]);
  });

  it("lists a remote town's tables as counts only — no usernames", async () => {
    const townA = await seedLocation();
    const townB = await seedLocation();
    const { token: callerToken, playerId: callerId } = await register();
    await placePlayer(callerId, townA, 1_000_000n);

    const { token: tokenX, playerId: idX, username: usernameX } = await register();
    const { token: tokenY, playerId: idY, username: usernameY } = await register();
    await placePlayer(idX, townB, 1_000_000n);
    await placePlayer(idY, townB, 1_000_000n);
    await sit(tokenX);
    await sit(tokenY);

    const res = await lobby(callerToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<LobbyBody>();

    expect(body.remote).toContainEqual(expect.objectContaining({
      locationId: townB, gameId: "blackjack", seated: 2,
    }));

    // Counts only — no usernames anywhere in the remote branch.
    const remoteJson = JSON.stringify(body.remote);
    expect(remoteJson).not.toContain(usernameX);
    expect(remoteJson).not.toContain(usernameY);
  });

  it("omits empty remote towns", async () => {
    const townA = await seedLocation();
    const townC = await seedLocation();
    const { playerId: ownerId } = await register();
    await seedHouse(townC, ownerId, 25_000n);

    const { token: callerToken, playerId: callerId } = await register();
    await placePlayer(callerId, townA, 1_000_000n);

    const res = await lobby(callerToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<LobbyBody>();

    // A house with no seats is not a remote table — nobody is playing there.
    expect(body.remote.some((row) => row.locationId === townC)).toBe(false);
  });
});

describe("shared DTO parity", () => {
  it("parses a live GET /api/casino/table body with CasinoTableResponseSchema", async () => {
    const locationId = await seedLocation();
    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);
    await sit(token);

    const res = await tableView(token);
    expect(res.statusCode).toBe(200);
    expect(() => CasinoTableResponseSchema.parse(res.json())).not.toThrow();
  });

  it("parses a live GET /api/casino lobby body with CasinoLobbyResponseSchema", async () => {
    const locationId = await seedLocation();
    const { token, playerId } = await register();
    await placePlayer(playerId, locationId, 1_000_000n);
    await sit(token);

    const res = await lobby(token);
    expect(res.statusCode).toBe(200);
    expect(() => CasinoLobbyResponseSchema.parse(res.json())).not.toThrow();
  });
});
