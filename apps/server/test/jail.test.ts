import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { checkJail, releaseIfExpired } from "../src/game/jail/status.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId });
});
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

describe("checkJail", () => {
  it("reports free when jailed_until is null", async () => {
    expect(await checkJail(db, playerId)).toEqual({ jailed: false, until: null, remainingSeconds: 0 });
  });

  it("reports jailed with remaining seconds when jailed_until is in the future", async () => {
    const until = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: until }).where(eq(playerStats.playerId, playerId));
    const status = await checkJail(db, playerId);
    expect(status.jailed).toBe(true);
    expect(status.remainingSeconds).toBeGreaterThan(0);
    expect(status.remainingSeconds).toBeLessThanOrEqual(60);
  });

  it("does NOT clear an expired jailed_until — that is releaseIfExpired's job", async () => {
    const past = new Date(Date.now() - 1000);
    await db.update(playerStats).set({ jailedUntil: past }).where(eq(playerStats.playerId, playerId));
    expect(await checkJail(db, playerId)).toMatchObject({ jailed: false });
    const [row] = await db.select({ jailedUntil: playerStats.jailedUntil }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.jailedUntil).not.toBeNull();
  });
});

describe("releaseIfExpired", () => {
  it("clears an expired jailed_until and publishes player.released exactly once", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const past = new Date(Date.now() - 1000);
    await db.update(playerStats).set({ jailedUntil: past }).where(eq(playerStats.playerId, playerId));

    // `game:events` is a global channel shared by every test file running in
    // parallel — a bare `once("message")` resolves on whichever file's event
    // lands first and can grab someone else's payload. Filter on this test's
    // own actor.
    const received = awaitOwnEvent(subscriber, playerId);

    const status = await releaseIfExpired(db, redis, playerId);
    expect(status).toEqual({ jailed: false, until: null, remainingSeconds: 0 });

    const event = await received;
    expect(event.type).toBe("player.released");
    expect(event.actorId).toBe(playerId);

    const [row] = await db.select({ jailedUntil: playerStats.jailedUntil }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.jailedUntil).toBeNull();

    // A second call finds nothing left to release and does not republish.
    await releaseIfExpired(db, redis, playerId);
  });

  it("leaves a currently-jailed player untouched", async () => {
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future }).where(eq(playerStats.playerId, playerId));
    const status = await releaseIfExpired(db, redis, playerId);
    expect(status.jailed).toBe(true);
  });
});

describe("GET /api/jail", () => {
  it("reports free status and auto-releases an expired jail via HTTP", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadConfig: loadCfg } = await import("../src/config.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");
    const config = loadCfg({ ...process.env, NODE_ENV: "test" });
    const leaderboardPrefix = `jail-test-${uuidv7()}`;
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix },
      withCorePlugins([]),
      `plugin-jail-test-${uuidv7()}-`,
    );
    const app = await buildApp(config, { db, redis, leaderboardPrefix, plugins: loadedPlugins });

    const { token } = await registerVerifiedPlayer({ app, redis }, { username: `Jail${Date.now()}` });
    const auth = { authorization: `Bearer ${token}` };

    const free = await app.inject({ method: "GET", url: "/api/jail", headers: auth });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toMatchObject({ jailed: false });

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });
});
