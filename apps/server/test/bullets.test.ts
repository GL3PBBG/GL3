import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bulletsPlugin from "@gl3/plugin-bullets";
import propertiesPlugin from "@gl3/plugin-properties";
import type { RouteResult } from "@gl3/plugin-sdk";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats, transactions } from "../src/db/schema/index.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;
let locationId: string;

// Required, never defaulted: an omitted prefix means the production
// `leaderboard:*` keys, which every concurrent test file and agent shares.
// The ctx buffers a cash leaderboard write on every applyBalanceChange
// (design §4.2), so this file now writes them where core's service did not.
const leaderboardPrefix = `bullets-test-${uuidv7()}`;

const buy = (forPlayerId: string, quantity: number) =>
  callPluginRoute(bulletsPlugin, "POST", "/api/bullets/buy", {
    db, redis, leaderboardPrefix, playerId: forPlayerId, body: { quantity },
  });

beforeAll(async () => {
  // This file drives the bullets route through callPluginRoute, not
  // bootTestServer, so nothing else applies the properties plugin's
  // migrations first — and bullets now queries properties' table via
  // ownerAt/payOwner (Task 9). resetDb() below truncates but never drops,
  // so running this once here (idempotent, tracked in plugin_migrations) is
  // enough for every test in the file.
  await runPluginMigrations(db, [propertiesPlugin]);
});

beforeEach(async () => {
  await resetDb(db);
  locationId = uuidv7();
  await db.insert(locations).values({ id: locationId, name: "Testville", bulletStock: 10, bulletCost: 5n });
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n, locationId });
});
afterAll(async () => {
  // Targeted DELs, never FLUSHDB — Redis is shared with every other test file.
  await redis.del(`${leaderboardPrefix}:cash`);
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("the bullets plugin handler", () => {
  it("debits cash, credits bullets, decrements shared stock, and publishes bullets.purchased", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // `game:events` is a global channel shared by every test file running in
    // parallel (e.g. travel.test.ts also publishes on it) — a bare
    // `once("message")` resolves on whichever file's event lands first and
    // can grab someone else's payload. Filter on this test's own actor.
    const received = awaitOwnEvent(subscriber, playerId);

    const result = await buy(playerId, 4);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ cash: "980", bullets: "4", bulletStock: 6 });

    const event = await received;
    expect(event.type).toBe("bullets.purchased");
    if (event.type !== "bullets.purchased") throw new Error("unreachable");
    expect(event.quantity).toBe(4);
    expect(event.cost).toBe("20");
  });

  it("rejects a player with no location", async () => {
    await db.update(playerStats).set({ locationId: null }).where(eq(playerStats.playerId, playerId));
    // The wire contract, not an internal class name: NoLocationError was
    // deleted with game/bullets/ and `no_location` is what a client sees.
    await expect(buy(playerId, 1)).rejects.toMatchObject({ code: "no_location", status: 409 });
  });

  it("rejects buying more than the location has in stock, and reports what is available", async () => {
    await expect(buy(playerId, 11)).rejects.toMatchObject({
      code: "insufficient_stock", status: 409, extra: { available: 10 },
    });
  });

  it("rejects a purchase the player can't afford", async () => {
    await db.update(playerStats).set({ cash: 1n }).where(eq(playerStats.playerId, playerId));
    await expect(buy(playerId, 1)).rejects.toMatchObject({ code: "insufficient_funds", status: 409 });

    // No ledger row and no stock change — a rejected purchase must leave no trace.
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    expect(rows).toHaveLength(0);
    const [loc] = await db.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
    expect(loc?.bulletStock).toBe(10);
  });

  // --- The defining risk of this task: two players buying simultaneously
  // against a shared stock of 1 must never both succeed (lost update /
  // oversell). This is the ONLY proof that tx.locks.location does its job,
  // and it has no HTTP equivalent.
  it("under concurrent purchase against a stock of 1, lets exactly one buyer succeed and never goes negative", async () => {
    await db.update(locations).set({ bulletStock: 1 }).where(eq(locations.id, locationId));

    const otherPlayerId = uuidv7();
    await db.insert(players).values({ id: otherPlayerId, username: `q${Date.now()}` });
    await db.insert(playerStats).values({ playerId: otherPlayerId, cash: 1000n, locationId });

    const results = await Promise.allSettled([buy(playerId, 1), buy(otherPlayerId, 1)]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<RouteResult> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "insufficient_stock", status: 409 });
    expect(fulfilled[0]).toMatchObject({ value: { body: { bulletStock: 0 } } });

    const [loc] = await db.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
    expect(loc?.bulletStock).toBe(0); // never negative

    const rows = await db.select().from(transactions).where(eq(transactions.reason, "bullets.purchase"));
    expect(rows).toHaveLength(1); // exactly one ledger row across both attempts
  });
});

describe("POST /api/bullets/buy", () => {
  it("buys bullets at the player's current location, jail-gates, and validates the body", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix },
      withCorePlugins([]),
      `plugin-bullets-test-${uuidv7()}-`,
    );
    const app = await buildApp(config, {
      db, redis, leaderboardPrefix, plugins: loadedPlugins,
    });
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: `Bullets${Date.now()}`, password: "hunter2hunter2" } });
    const { token, playerId: registeredId } = reg.json();
    const auth = { authorization: `Bearer ${token}` };
    await db.update(playerStats).set({ cash: 1000n, locationId }).where(eq(playerStats.playerId, registeredId));

    const buy = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 3 } });
    expect(buy.statusCode).toBe(200);
    expect(buy.json()).toEqual({ cash: "985", bullets: "3", bulletStock: 7 });

    // Design §4.2: core's bullets service never called recordScore, but the
    // ctx buffers one leaderboard write per changed kind and flushes it after
    // commit. A deliberate divergence, asserted so it stays proven.
    expect(await redis.zscore(`${leaderboardPrefix}:cash`, registeredId)).toBe("985");

    const badBody = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 0 } });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toEqual({ error: "invalid_request" });

    const negative = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: -1 } });
    expect(negative.statusCode).toBe(400);

    const nonInteger = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 1.5 } });
    expect(nonInteger.statusCode).toBe(400);

    // Player with no location.
    await db.update(playerStats).set({ locationId: null }).where(eq(playerStats.playerId, registeredId));
    const noLocation = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 1 } });
    expect(noLocation.statusCode).toBe(409);
    expect(noLocation.json()).toEqual({ error: "no_location" });
    await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, registeredId));

    // Insufficient stock.
    const tooMany = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 999 } });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json()).toMatchObject({ error: "insufficient_stock" });

    // Insufficient funds.
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, registeredId));
    const noFunds = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 1 } });
    expect(noFunds.statusCode).toBe(409);
    expect(noFunds.json()).toEqual({ error: "insufficient_funds" });

    // Jailed player is rejected before any purchase work.
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future, cash: 1000n }).where(eq(playerStats.playerId, registeredId));
    const jailed = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 1 } });
    expect(jailed.statusCode).toBe(423);
    expect(jailed.json()).toMatchObject({ error: "jailed" });
    expect(jailed.headers["retry-after"]).toBe(String(jailed.json().remainingSeconds));

    const unauthenticated = await app.inject({ method: "POST", url: "/api/bullets/buy", payload: { quantity: 1 } });
    expect(unauthenticated.statusCode).toBe(401);

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });
});
