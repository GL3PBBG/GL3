import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { definePlugin, on, type PluginManifest } from "@gl3/plugin-sdk";
import { dealTable, type BjTableState } from "@gl3/plugin-blackjack";
import { games, type GameDef } from "@gl3/plugin-casino";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { FARO } from "./helpers/faro.js";
import { casinoTables, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { seedVenues } from "./helpers/venues.js";

/**
 * Spec 2026-09-21 town-venues §5: `play`, `table/sit` and `machine/open`
 * refuse `no_venue` unless a `p_properties_properties` row exists for
 * `(location_id, "blackjack")` in the caller's town. Everything that acts
 * on an ALREADY-open session/seat/wallet (bet/act/leave/cashout, plus the
 * floor and lobby reads) is unaffected — a row can be removed mid-hand and
 * nobody's money is stranded.
 *
 * `faro` doubles as both the solo game and, wrapped `machine: true`, the
 * machine game — the venue gate is about the casino DOOR existing, not
 * about which game's own house row does, so no `faro` property row is ever
 * seeded here.
 */
const { db, sql: conn } = testDb();

const faroMachine: GameDef = { ...FARO, machine: true } as GameDef;
const faroPlugin: PluginManifest = definePlugin({
  id: "faro",
  version: "1.0.0",
  basePaths: ["/api/faro"],
  filters: [on(games, (_ctx, list) => [...list, faroMachine])],
});

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [faroPlugin] }));
});
afterAll(async () => { await closeServer?.(); await conn.end(); });

let regCounter = 0;
async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Venue${regCounter}`,
    remoteAddress: `10.64.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

/** Deliberately does NOT seed a venue — every case seeds one explicitly. */
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

function play(token: string, gameId: string, wager: string) {
  return app.inject({
    method: "POST", url: "/api/casino/play",
    headers: { authorization: `Bearer ${token}` }, payload: { gameId, wager },
  });
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

function machineRequest(token: string, verb: string, payload?: unknown) {
  return app.inject({
    method: payload === undefined ? "GET" : "POST",
    url: `/api/casino/machine${verb ? "/" + verb : ""}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function openMachine(token: string) {
  return machineRequest(token, "open", { gameId: "faro", credits: "1000", wager: "100" });
}

function floor(token: string) {
  return app.inject({ method: "GET", url: "/api/casino/floor", headers: { authorization: `Bearer ${token}` } });
}

function lobby(token: string) {
  return app.inject({ method: "GET", url: "/api/casino", headers: { authorization: `Bearer ${token}` } });
}

async function tableRow(tableId: string) {
  const [row] = await db.select().from(casinoTables).where(eq(casinoTables.id, tableId));
  return row;
}

async function setSeed(tableId: string, seed: string): Promise<void> {
  await db.update(casinoTables).set({ seed }).where(eq(casinoTables.id, tableId));
}

/** `casino-table-money.test.ts`'s scanning idiom: deals are pure, find one. */
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

async function removeVenue(locationId: string): Promise<void> {
  await db.delete(propertiesTable)
    .where(and(eq(propertiesTable.locationId, locationId), eq(propertiesTable.pluginId, "blackjack")));
}

describe("casino venue gates (spec 2026-09-21 town-venues §5)", () => {
  it("refuses play, sit and machine/open with 409 no_venue in a town with no casino row", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    const playRes = await play(token, "faro", "10000");
    expect(playRes.statusCode).toBe(409);
    expect(playRes.json<{ error: string }>().error).toBe("no_venue");

    const sitRes = await sit(token);
    expect(sitRes.statusCode).toBe(409);
    expect(sitRes.json<{ error: string }>().error).toBe("no_venue");

    const openRes = await openMachine(token);
    expect(openRes.statusCode).toBe(409);
    expect(openRes.json<{ error: string }>().error).toBe("no_venue");
  });

  it("succeeds at play, sit and machine/open once a state-run casino row exists", async () => {
    const locationId = await seedLocation();
    await seedVenues(db, [locationId]);

    const player = await register();
    await placePlayer(player.playerId, locationId, 1_000_000n);
    expect((await play(player.token, "faro", "10000")).statusCode).toBe(200);

    const sitter = await register();
    await placePlayer(sitter.playerId, locationId, 1_000_000n);
    expect((await sit(sitter.token)).statusCode).toBe(200);

    const gambler = await register();
    await placePlayer(gambler.playerId, locationId, 1_000_000n);
    expect((await openMachine(gambler.token)).statusCode).toBe(200);
  });

  it("keeps an already-open session, a seated hand and an open wallet working (settle/leave/cash out) after the venue row is removed mid-hand, and leaves the floor and lobby answering", async () => {
    const locationId = await seedLocation();
    await seedVenues(db, [locationId]);

    const a = await register();
    const b = await register();
    await placePlayer(a.playerId, locationId, 1_000_000n);
    await placePlayer(b.playerId, locationId, 1_000_000n);

    const sitA = await sit(a.token);
    expect(sitA.statusCode).toBe(200);
    const { tableId } = sitA.json<{ tableId: string }>();
    expect((await sit(b.token)).statusCode).toBe(200);

    const walletOwner = await register();
    await placePlayer(walletOwner.playerId, locationId, 1_000_000n);
    const opened = (await openMachine(walletOwner.token)).json<{ machine: { id: string; revision: number } }>().machine;

    const W = 10_000n;
    const bettors = [{ seat: 0, wager: W }, { seat: 1, wager: W }];
    const seed = probeSeed(bettors, (s) => s.hands.every((h) => h.phase === "playing"), "venue-removed-mid-hand");

    // The venue row is gone from here on — every remaining call in this test
    // hits an already-open session/seat/wallet, never `play`/`sit`/`open`.
    await removeVenue(locationId);

    expect((await bet(a.token, W)).statusCode).toBe(200);
    await setSeed(tableId, seed);
    expect((await bet(b.token, W)).statusCode).toBe(200);
    expect((await tableRow(tableId))?.phase).toBe("acting");

    expect((await tableView(a.token)).statusCode).toBe(200);

    expect((await tableAct(a.token, "stand")).statusCode).toBe(200);
    expect((await tableAct(b.token, "stand")).statusCode).toBe(200);
    expect((await tableRow(tableId))?.phase).toBe("betting");

    expect((await leave(a.token)).statusCode).toBe(200);
    expect((await leave(b.token)).statusCode).toBe(200);

    const cashedOut = await machineRequest(walletOwner.token, "cashout", { id: opened.id, revision: opened.revision });
    expect(cashedOut.statusCode).toBe(200);
    expect(cashedOut.json<{ cashedOut: string }>().cashedOut).toBe("1000");

    expect((await floor(a.token)).statusCode).toBe(200);
    const lobbyRes = await lobby(a.token);
    expect(lobbyRes.statusCode).toBe(200);
    // `available` means "game registered", never venue presence.
    const lobbyBody = lobbyRes.json<{ tableGames: { gameId: string }[] }>();
    expect(lobbyBody.tableGames.some((g) => g.gameId === "blackjack")).toBe(true);
  });
});
