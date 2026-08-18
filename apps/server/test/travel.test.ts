import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import travelPlugin from "@gl3/plugin-travel";
import { PluginError, type PluginCtx, type RouteResult } from "@gl3/plugin-sdk";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats, transactions } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { loadSnapshot } from "../src/plugins/routes.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { callPluginRoute } from "./helpers/plugin-route.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `travel-test-${uuidv7()}`;

let playerId: string;
let chicagoId: string;
let miamiId: string;
let denverId: string;

const travel = (toLocationId: string) =>
  callPluginRoute(travelPlugin, "POST", "/api/travel/:locationId", {
    db, redis, leaderboardPrefix, playerId, params: { locationId: toLocationId },
  });

/**
 * Same non-HTTP contract as `callPluginRoute` (see its own header comment)
 * but hand-builds `ctx` so a test can see every `ctx.transaction` call
 * boundary as it happens. `travelRoute` opens exactly one transaction for
 * the destination lookup, then `attemptTravel` opens exactly two per attempt
 * (the unlocked pre-read, then the locked recheck) — so `onTransactionSettled`
 * fires once per boundary, 1-indexed across the whole call, and a test can
 * commit a plain write between two specific calls to force `LocationMovedRetry`
 * deterministically.
 *
 * This is a sequential-external-write technique, not real concurrency:
 * everything here runs on one thread, so it proves the retry/staleness-
 * detection path (`LocationMovedRetry`), not the necessity of the explicit
 * `tx.locks.player` call inside the locked block — a plain re-read under
 * READ COMMITTED sees the same committed row regardless of whether that lock
 * is held. See task-3-report.md's I1 section for why that distinction
 * matters and what proving the lock itself would require.
 *
 * Only test-file code: `ctx` is a plain object literal returned by
 * `createPluginCtx` (apps/server/src/plugins/ctx.ts), so spreading it with an
 * overridden `transaction` needs no production seam.
 */
async function travelWithTransactionHook(
  toLocationId: string,
  calls: { count: number },
  onTransactionSettled: (callNumber: number) => Promise<void>,
): Promise<RouteResult> {
  const pluginRoute = travelPlugin.routes.find(
    (r) => r.method === "POST" && r.path === "/api/travel/:locationId",
  );
  if (pluginRoute === undefined) throw new Error("travel plugin has no POST /api/travel/:locationId route");

  const deps = { db, redis, queues: new Map(), settings: {}, leaderboardPrefix };
  const player = await loadSnapshot(deps, playerId);
  const ctx = createPluginCtx(deps, {
    pluginId: travelPlugin.id, player, job: null, filters: travelPlugin.filters, propertyTypes: new Map(),
    installedPluginIds: new Set([travelPlugin.id]),
  });

  const realTransaction = ctx.transaction.bind(ctx);
  const hookedTransaction: PluginCtx["transaction"] = async (fn) => {
    calls.count += 1;
    const callNumber = calls.count;
    const result = await realTransaction(fn);
    await onTransactionSettled(callNumber);
    return result;
  };
  const hookedCtx: PluginCtx = { ...ctx, transaction: hookedTransaction };

  const params = pluginRoute.params.parse({ locationId: toLocationId });
  const body = pluginRoute.body.parse({});
  return pluginRoute.handler(hookedCtx, { params, body });
}

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n });

  chicagoId = uuidv7();
  miamiId = uuidv7();
  denverId = uuidv7();
  await db.insert(locations).values([
    { id: chicagoId, name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: miamiId, name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
    // Zero fare: schema default (content.ts:31 `.default(sql\`0\`)`), not an
    // exotic case. The only path that depends on the explicit tx.locks.player
    // call at index.ts — a zero-fare travel never calls applyBalanceChange,
    // which is where every non-zero fare's player lock comes from.
    { id: denverId, name: "Denver", travelCost: 0n, travelCooldownSeconds: 45, bulletStock: 200, bulletCost: 3n },
  ]);
  await redis.del(cooldownKey(playerId, "travel"));
});

afterAll(async () => {
  await redis.del(`${leaderboardPrefix}:cash`, `${leaderboardPrefix}:bank`, `${leaderboardPrefix}:exp`);
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("POST /api/travel/:locationId", () => {
  it("debits the fare, moves the player, and publishes player.travelled with a null fromLocationId the first time", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // `game:events` is global across test files — filter on this test's actor
    // (CLAUDE.md rule 4).
    const received = awaitOwnEvent(subscriber, playerId);

    const result = await travel(chicagoId);
    expect(result).toEqual({ status: 200, body: { locationId: chicagoId, cash: "900" } });

    const event = await received;
    expect(event.type).toBe("player.travelled");
    if (event.type !== "player.travelled") throw new Error("unreachable");
    expect(event.fromLocationId).toBeNull();
    expect(event.toLocationId).toBe(chicagoId);
    expect(event.cost).toBe("100");
  });

  it("rejects travelling to the player's current location", async () => {
    await travel(chicagoId);
    await redis.del(cooldownKey(playerId, "travel"));
    await expect(travel(chicagoId)).rejects.toMatchObject({ code: "already_there", status: 409 });
  });

  it("commits a zero-fare travel and charges nothing", async () => {
    const result = await travel(denverId);
    expect(result).toEqual({ status: 200, body: { locationId: denverId, cash: "1000" } });

    const [row] = await db
      .select({ locationId: playerStats.locationId, cash: playerStats.cash })
      .from(playerStats)
      .where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBe(denverId);
    expect(row?.cash).toBe(1000n);
  });

  it("retries after the player moves between the pre-read and the lock, charging the fare exactly once", async () => {
    const calls = { count: 0 };
    const result = await travelWithTransactionHook(chicagoId, calls, async (callNumber) => {
      // Call 2 is attemptTravel's unlocked pre-read on attempt 1 (call 1 is
      // travelRoute's destination lookup, before attemptTravel is entered).
      // Committing a plain move here — after that read returns, before the
      // locked recheck opens as call 3 — lands the write exactly in the
      // window LocationMovedRetry exists to detect.
      if (callNumber === 2) {
        await db.update(playerStats).set({ locationId: miamiId }).where(eq(playerStats.playerId, playerId));
      }
    });

    expect(result).toEqual({ status: 200, body: { locationId: chicagoId, cash: "900" } });
    // 1 (destination lookup) + 2 per attempt x 2 attempts (attempt 1 aborts on
    // the mismatch, attempt 2 commits) = 5. A wrong count would mean either
    // the retry never fired (still 3: no LocationMovedRetry at all) or fired
    // more than once (7+: the mismatch reproduced on the retry's own re-read).
    expect(calls.count).toBe(5);

    const [row] = await db
      .select({ locationId: playerStats.locationId, cash: playerStats.cash })
      .from(playerStats)
      .where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBe(chicagoId);
    expect(row?.cash).toBe(900n);

    // Row count, not just the cash string: a double-charge that netted to the
    // same balance (e.g. charge then refund) would pass a cash-only assertion.
    const fareRows = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.playerId, playerId), eq(transactions.reason, "travel.cost")));
    expect(fareRows).toHaveLength(1);
    expect(fareRows[0]?.amount).toBe(-100n);
  });

  it("answers a clean 409 location_changed when the player keeps moving through every attempt", async () => {
    const calls = { count: 0 };
    const error = await travelWithTransactionHook(chicagoId, calls, async (callNumber) => {
      // Calls 2, 4, 6 are the pre-read of attempts 1, 2 and 3. Moving the
      // player after each one reproduces the mismatch on every attempt's
      // locked recheck, exhausting MAX_ATTEMPTS. Alternate the destination
      // so each move is a real change from wherever the previous one left
      // the player (never chicagoId itself, or the pre-read would see
      // "already there" instead of a mismatch).
      if (callNumber === 2 || callNumber === 4 || callNumber === 6) {
        const decoy = callNumber === 4 ? denverId : miamiId;
        await db.update(playerStats).set({ locationId: decoy }).where(eq(playerStats.playerId, playerId));
      }
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PluginError);
    if (!(error instanceof PluginError)) throw new Error("unreachable");
    expect(error.code).toBe("location_changed");
    expect(error.status).toBe(409);
    // 1 (destination lookup) + 2 per attempt x 3 attempts, all three mismatching.
    expect(calls.count).toBe(7);

    // No commit happened on any attempt: no fare charged, cooldown released
    // rather than stranding the player behind a trip that never landed.
    const fareRows = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.playerId, playerId), eq(transactions.reason, "travel.cost")));
    expect(fareRows).toHaveLength(0);
    expect(await redis.exists(cooldownKey(playerId, "travel"))).toBe(0);
  });

  it("rejects an unknown location", async () => {
    await expect(travel(uuidv7())).rejects.toMatchObject({ code: "location_not_found", status: 404 });
  });

  it("rejects a fare the player can't afford and leaves them in place", async () => {
    await db.update(playerStats).set({ cash: 50n }).where(eq(playerStats.playerId, playerId));
    await expect(travel(miamiId)).rejects.toMatchObject({ code: "insufficient_funds", status: 409 });

    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBeNull();
  });

  it("gates on the per-player travel cooldown and answers with a retry-after header", async () => {
    await travel(chicagoId);
    const err = await travel(miamiId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    if (!(err instanceof PluginError)) throw new Error("unreachable");
    expect(err.status).toBe(429);
    expect(err.code).toBe("on_cooldown");
    expect(Number(err.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("releases the cooldown when the travel itself fails, so a rejected trip does not strand the player", async () => {
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, playerId));
    await expect(travel(miamiId)).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await redis.exists(cooldownKey(playerId, "travel"))).toBe(0);
  });
});

describe("GET /api/locations", () => {
  it("lists every location, marks the current one, and reports the live cooldown", async () => {
    const before = await callPluginRoute(travelPlugin, "GET", "/api/locations", {
      db, redis, leaderboardPrefix, playerId,
    });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      locations: expect.arrayContaining([
        expect.objectContaining({ id: chicagoId, name: "Chicago", travelCost: "100", current: false, cooldownRemaining: 0 }),
      ]),
    });

    await travel(chicagoId);

    const after = await callPluginRoute(travelPlugin, "GET", "/api/locations", {
      db, redis, leaderboardPrefix, playerId,
    });
    const listed = (after.body as { locations: { id: string; current: boolean; cooldownRemaining: number }[] }).locations;
    expect(listed.find((l) => l.id === chicagoId)?.current).toBe(true);
    expect(listed.find((l) => l.id === chicagoId)?.cooldownRemaining).toBeGreaterThan(0);
  });
});

describe("GET /api/locations and POST /api/travel/:locationId", () => {
  it("lists locations, travels, cooldown-gates, re-blocks the same destination, and jail-gates", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");
    const { cooldownKey } = await import("../src/game/cooldown.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix },
      withCorePlugins([]),
      `plugin-travel-test-${uuidv7()}-`,
    );
    const app = await buildApp(config, { db, redis, leaderboardPrefix, plugins: loadedPlugins });
    const { token, playerId: registeredId } = await registerVerifiedPlayer({ app, redis }, { username: `Travel${Date.now()}` });
    const auth = { authorization: `Bearer ${token}` };
    // Registration starts a player at 0 cash — fund them directly so travel
    // fares below have something to spend.
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, registeredId));

    const list = await app.inject({ method: "GET", url: "/api/locations", headers: auth });
    expect(list.statusCode).toBe(200);
    const listed = list.json().locations;
    // Tracks the shared beforeEach fixture above (Chicago, Miami, Denver) —
    // bump this if that fixture grows another location.
    expect(listed).toHaveLength(3);
    const chicago = listed.find((l: { id: string }) => l.id === chicagoId);
    expect(chicago).toMatchObject({ name: "Chicago", travelCost: "100", current: false, cooldownRemaining: 0 });
    // Money crosses the wire as a decimal string, never a JSON number — a
    // zero-fare location is the case most likely to regress to the bare
    // number 0 rather than the string "0", and nothing else on the wire
    // asserts the zero case.
    const denver = listed.find((l: { id: string }) => l.id === denverId);
    expect(denver).toMatchObject({ name: "Denver", travelCost: "0", current: false, cooldownRemaining: 0 });

    const travel = await app.inject({ method: "POST", url: `/api/travel/${chicagoId}`, headers: auth });
    expect(travel.statusCode).toBe(200);
    expect(travel.json()).toEqual({ locationId: chicagoId, cash: "900" });

    // Chicago's 60s cooldown is now live — any further travel, even to a
    // different destination, is blocked until it expires (spec §1.2
    // L_cooldown is a single per-player travel cooldown, not per-route).
    const blocked = await app.inject({ method: "POST", url: `/api/travel/${miamiId}`, headers: auth });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: "on_cooldown", retryAfter: expect.any(Number) });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

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
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });

  it("404s a well-formed but unknown location id and 400s a malformed one", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix },
      withCorePlugins([]),
      `plugin-travel-test-${uuidv7()}-`,
    );
    const app = await buildApp(config, { db, redis, leaderboardPrefix, plugins: loadedPlugins });
    const { token } = await registerVerifiedPlayer({ app, redis }, { username: `Travel404${Date.now()}` });
    const auth = { authorization: `Bearer ${token}` };

    const missing = await app.inject({ method: "POST", url: `/api/travel/${uuidv7()}`, headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "location_not_found" });

    const malformed = await app.inject({ method: "POST", url: "/api/travel/not-a-uuid", headers: auth });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "invalid_request" });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/locations" });
    expect(unauthenticated.statusCode).toBe(401);

    // Parity with core, not a regression, but the money-moving route deserves
    // its own 401 assertion rather than relying solely on GET's.
    const unauthenticatedPost = await app.inject({ method: "POST", url: `/api/travel/${chicagoId}` });
    expect(unauthenticatedPost.statusCode).toBe(401);

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });
});
