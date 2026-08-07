import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { AlreadyAtLocationError, LocationNotFoundError, performTravel } from "../src/game/travel/service.js";
import { InsufficientFundsError } from "../src/economy/ledger.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;
let chicagoId: string;
let miamiId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n });

  chicagoId = uuidv7();
  miamiId = uuidv7();
  await db.insert(locations).values([
    { id: chicagoId, name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: miamiId, name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
});
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

describe("performTravel", () => {
  it("debits the travel cost, moves the player, and publishes player.travelled with a null fromLocationId the first time", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = new Promise((resolve) => {
      subscriber.once("message", (channel, raw) => { if (channel === GAME_EVENTS_CHANNEL) resolve(JSON.parse(raw)); });
    });

    const result = await performTravel(db, redis, playerId, chicagoId);
    expect(result).toEqual({ locationId: chicagoId, cash: "900" });

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("player.travelled");
    if (event.type !== "player.travelled") throw new Error("unreachable");
    expect(event.fromLocationId).toBeNull();
    expect(event.toLocationId).toBe(chicagoId);
    expect(event.cost).toBe("100");
  });

  it("rejects travelling to the player's current location", async () => {
    await performTravel(db, redis, playerId, chicagoId);
    await expect(performTravel(db, redis, playerId, chicagoId)).rejects.toBeInstanceOf(AlreadyAtLocationError);
  });

  it("rejects an unknown location", async () => {
    await expect(performTravel(db, redis, playerId, uuidv7())).rejects.toBeInstanceOf(LocationNotFoundError);
  });

  it("rejects travel the player can't afford and leaves them in place", async () => {
    await db.update(playerStats).set({ cash: 50n }).where(eq(playerStats.playerId, playerId));
    await expect(performTravel(db, redis, playerId, miamiId)).rejects.toBeInstanceOf(InsufficientFundsError);
    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBeNull();
  });
});

describe("GET /api/locations and POST /api/travel/:locationId", () => {
  it("lists locations, travels, cooldown-gates, re-blocks the same destination, and jail-gates", async () => {
    const { buildApp } = await import("../src/app.js");
    const { createCrimeQueue } = await import("../src/queue/index.js");
    const { cooldownKey } = await import("../src/game/cooldown.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const app = await buildApp(config, { db, redis, crimeQueue: createCrimeQueue(createRedis(config.redisUrl)) });
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: `Travel${Date.now()}`, password: "hunter2hunter2" } });
    const { token, playerId: registeredId } = reg.json();
    const auth = { authorization: `Bearer ${token}` };
    // Registration starts a player at 0 cash — fund them directly so travel
    // fares below have something to spend.
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, registeredId));

    const list = await app.inject({ method: "GET", url: "/api/locations", headers: auth });
    expect(list.statusCode).toBe(200);
    const listed = list.json().locations;
    expect(listed).toHaveLength(2);
    const chicago = listed.find((l: { id: string }) => l.id === chicagoId);
    expect(chicago).toMatchObject({ name: "Chicago", travelCost: "100", current: false, cooldownRemaining: 0 });

    const travel = await app.inject({ method: "POST", url: `/api/travel/${chicagoId}`, headers: auth });
    expect(travel.statusCode).toBe(200);
    expect(travel.json()).toEqual({ locationId: chicagoId, cash: "900" });

    // Chicago's 60s cooldown is now live — any further travel, even to a
    // different destination, is blocked until it expires (spec §1.2
    // L_cooldown is a single per-player travel cooldown, not per-route).
    const blocked = await app.inject({ method: "POST", url: `/api/travel/${miamiId}`, headers: auth });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: "on_cooldown" });

    // Simulate the cooldown having elapsed so the same-destination rejection
    // (not the cooldown) is what's under test next.
    await redis.del(cooldownKey(registeredId, "travel"));
    const sameDestination = await app.inject({ method: "POST", url: `/api/travel/${chicagoId}`, headers: auth });
    expect(sameDestination.statusCode).toBe(409);
    expect(sameDestination.json()).toEqual({ error: "already_there" });
    // The failed attempt must not have re-stranded the player behind a
    // cooldown for a trip that never happened.
    await redis.del(cooldownKey(registeredId, "travel"));

    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future }).where(eq(playerStats.playerId, registeredId));
    const jailed = await app.inject({ method: "POST", url: `/api/travel/${miamiId}`, headers: auth });
    expect(jailed.statusCode).toBe(423);
    expect(jailed.json()).toMatchObject({ error: "jailed" });

    await app.close();
  });

  it("404s a well-formed but unknown location id and 400s a malformed one", async () => {
    const { buildApp } = await import("../src/app.js");
    const { createCrimeQueue } = await import("../src/queue/index.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const app = await buildApp(config, { db, redis, crimeQueue: createCrimeQueue(createRedis(config.redisUrl)) });
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: `Travel404${Date.now()}`, password: "hunter2hunter2" } });
    const { token } = reg.json();
    const auth = { authorization: `Bearer ${token}` };

    const missing = await app.inject({ method: "POST", url: `/api/travel/${uuidv7()}`, headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "location_not_found" });

    const malformed = await app.inject({ method: "POST", url: "/api/travel/not-a-uuid", headers: auth });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "invalid_request" });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/locations" });
    expect(unauthenticated.statusCode).toBe(401);

    await app.close();
  });
});
