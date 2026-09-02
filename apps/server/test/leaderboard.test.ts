import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { encodeLevelScore } from "@gl3/shared";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { players, playerStats } from "../src/db/schema/index.js";
import bankPlugin from "@gl3/plugin-bank";
import { callPluginRoute } from "./helpers/plugin-route.js";
import { rebuildLeaderboards, recordScore, topN } from "../src/game/leaderboard/service.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

// leaderboard:* keys are global by design in production (spec §2.2: one
// Redis, one game), but Redis is one shared instance across every test file
// (and agent) running in parallel. A per-file namespace — same fix as the
// private BullMQ queue name in test/helpers/server.ts — keeps this file's
// exact top-N assertions deterministic without a destructive flushdb() and
// without deleting keys another file's concurrent bootTestServer() sweep
// owns.
const PREFIX = `leaderboard-test-${randomUUID()}`;

beforeEach(async () => { await resetDb(db); await redis.del(`${PREFIX}:cash`, `${PREFIX}:bank`, `${PREFIX}:exp`); });
afterAll(async () => { await conn.end(); redis.disconnect(); });

const insertPlayer = async (username: string, cash: bigint, exp: bigint): Promise<string> => {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id, cash, exp });
  return id;
};

describe("recordScore / topN", () => {
  it("ranks players highest-score-first", async () => {
    const a = await insertPlayer("Alice", 100n, 0n);
    const b = await insertPlayer("Bob", 500n, 0n);
    const c = await insertPlayer("Carol", 250n, 0n);
    await recordScore(redis, "cash", a, 100n, PREFIX);
    await recordScore(redis, "cash", b, 500n, PREFIX);
    await recordScore(redis, "cash", c, 250n, PREFIX);

    const top = await topN(db, redis, "cash", 10, PREFIX);
    expect(top.map((e) => e.username)).toEqual(["Bob", "Carol", "Alice"]);
    expect(top.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("returns an empty list when nobody has a score yet", async () => {
    expect(await topN(db, redis, "exp", 10, PREFIX)).toEqual([]);
  });
});

describe("rebuildLeaderboards", () => {
  it("sweeps every player_stats row into all three sorted sets, idempotently", async () => {
    const a = await insertPlayer("Alice", 100n, 20n);
    const b = await insertPlayer("Bob", 500n, 5n);

    await rebuildLeaderboards(db, redis, PREFIX);
    await rebuildLeaderboards(db, redis, PREFIX); // second call must not duplicate members or scores

    const byCash = await topN(db, redis, "cash", 10, PREFIX);
    expect(byCash).toHaveLength(2);
    expect(byCash[0]?.username).toBe("Bob");

    const byExp = await topN(db, redis, "exp", 10, PREFIX);
    expect(byExp[0]?.username).toBe("Alice");
  });

  it("writes a level-composite exp score when routed, and converges back to raw exp when not", async () => {
    const a = await insertPlayer("Alice", 100n, 20n); // level defaults to 1
    await db.update(playerStats).set({ level: 3 }).where(eq(playerStats.playerId, a));
    const b = await insertPlayer("Bob", 500n, 999_999n); // level 1, huge within-level exp

    await rebuildLeaderboards(db, redis, PREFIX, true);
    expect(await redis.zscore(`${PREFIX}:exp`, a)).toBe(encodeLevelScore(3, 20n).toString());
    expect(await redis.zscore(`${PREFIX}:exp`, b)).toBe(encodeLevelScore(1, 999_999n).toString());
    // cash/bank are untouched by `routed` — same raw values either way.
    expect(await redis.zscore(`${PREFIX}:cash`, a)).toBe("100");
    // Level 3, 20 exp outranks level 1, 999999 exp — the whole point of the composite.
    const routedTop = await topN(db, redis, "exp", 10, PREFIX);
    expect(routedTop[0]?.username).toBe("Alice");

    await rebuildLeaderboards(db, redis, PREFIX, false); // second call, routed=false: converges back to raw, idempotently
    expect(await redis.zscore(`${PREFIX}:exp`, a)).toBe("20");
    const rawTop = await topN(db, redis, "exp", 10, PREFIX);
    expect(rawTop[0]?.username).toBe("Bob"); // raw exp: Bob's 999999 beats Alice's 20
  });
});

describe("GET /api/leaderboard/:kind", () => {
  it("reflects a live update from a bank deposit, and rejects an unknown kind", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix: PREFIX },
      withCorePlugins([]),
      `plugin-leaderboard-test-${uuidv7()}-`,
    );
    const app = await buildApp(config, {
      db, redis, leaderboardPrefix: PREFIX, plugins: loadedPlugins,
    });

    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: `Board${Date.now()}` });
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));

    // Drives the bank plugin's route: this is what proves the ctx buffers a
    // leaderboard write per changed kind, with no plugin-side recordScore.
    await callPluginRoute(bankPlugin, "POST", "/api/bank/deposit", {
      db, redis, leaderboardPrefix: PREFIX, playerId, body: { amount: "300" },
    });

    const res = await app.inject({ method: "GET", url: "/api/leaderboard/cash", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("cash");
    expect(body.entries.some((e: { playerId: string; score: string }) => e.playerId === playerId && e.score === "700")).toBe(true);

    // scope=all must be byte-identical to sending no scope at all: recordScore,
    // rebuildLeaderboards and topN are unmodified by rounds, and this is what
    // pins that every caller sending no querystring — the web client included —
    // keeps getting exactly this ZSET-backed payload.
    const explicitAll = await app.inject({ method: "GET", url: "/api/leaderboard/cash?scope=all", headers: { authorization: `Bearer ${token}` } });
    expect(explicitAll.statusCode).toBe(200);
    expect(explicitAll.json()).toEqual(body);

    const bad = await app.inject({ method: "GET", url: "/api/leaderboard/not-a-kind", headers: { authorization: `Bearer ${token}` } });
    expect(bad.statusCode).toBe(400);

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });
});

describe("GET /api/leaderboard/:kind — mode field on routed vs unrouted boots", () => {
  it("answers mode: \"level\" for the exp board on a routed (gl3-profile) boot, ordered level-first; absent for cash", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { bundledPlugins } = await import("../src/plugins/core-plugins.js");

    const routedPrefix = `${PREFIX}-routed`;
    await redis.del(`${routedPrefix}:cash`, `${routedPrefix}:bank`, `${routedPrefix}:exp`);

    const config = loadConfig({ ...process.env, NODE_ENV: "test", GL3_PROFILE: "gl3" });
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix: routedPrefix },
      bundledPlugins("gl3", []), // includes progression, the exp-routing claimant
      `plugin-leaderboard-routed-test-${uuidv7()}-`,
      "gl3",
    );
    const app = await buildApp(config, { db, redis, leaderboardPrefix: routedPrefix, plugins: loadedPlugins });

    const { token } = await registerVerifiedPlayer({ app, redis }, { username: `BoardV${Date.now()}` });

    // Lv2/low-exp must outrank Lv1/huge-exp — the whole point of the composite.
    const low = await insertPlayer("LowLevelHighExp", 0n, 999_999n);
    const high = await insertPlayer("HighLevelLowExp", 0n, 5n);
    await db.update(playerStats).set({ level: 2 }).where(eq(playerStats.playerId, high));
    await rebuildLeaderboards(db, redis, routedPrefix, true);

    const exp = await app.inject({ method: "GET", url: "/api/leaderboard/exp", headers: { authorization: `Bearer ${token}` } });
    expect(exp.statusCode).toBe(200);
    const expBody = exp.json();
    expect(expBody.mode).toBe("level");
    expect(expBody.entries[0]?.playerId).toBe(high);
    expect(expBody.entries[1]?.playerId).toBe(low);

    const cash = await app.inject({ method: "GET", url: "/api/leaderboard/cash", headers: { authorization: `Bearer ${token}` } });
    expect(cash.statusCode).toBe(200);
    expect(cash.json().mode).toBeUndefined();

    // scope=round must carry the same mode rule for the exp kind — the deltas are composite deltas.
    const round = await app.inject({ method: "GET", url: "/api/leaderboard/exp?scope=round", headers: { authorization: `Bearer ${token}` } });
    expect(round.statusCode).toBe(200);
    expect(round.json().mode).toBe("level");

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });

  it("answers no mode on a v2-profile (unrouted) boot — raw ordering", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");

    const v2Prefix = `${PREFIX}-v2`;
    await redis.del(`${v2Prefix}:cash`, `${v2Prefix}:bank`, `${v2Prefix}:exp`);

    const config = loadConfig({ ...process.env, NODE_ENV: "test", GL3_PROFILE: "v2" });
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix: v2Prefix },
      withCorePlugins([]), // no progression — no exp-routing claimant
      `plugin-leaderboard-v2-test-${uuidv7()}-`,
      "v2",
    );
    const app = await buildApp(config, { db, redis, leaderboardPrefix: v2Prefix, plugins: loadedPlugins });

    const { token } = await registerVerifiedPlayer({ app, redis }, { username: `BoardU${Date.now()}` });

    const low = await insertPlayer("RawLow", 0n, 5n);
    const high = await insertPlayer("RawHigh", 0n, 999_999n);
    await db.update(playerStats).set({ level: 2 }).where(eq(playerStats.playerId, low)); // level must not matter here
    await rebuildLeaderboards(db, redis, v2Prefix, false);

    const exp = await app.inject({ method: "GET", url: "/api/leaderboard/exp", headers: { authorization: `Bearer ${token}` } });
    expect(exp.statusCode).toBe(200);
    const body = exp.json();
    expect(body.mode).toBeUndefined();
    expect(body.entries[0]?.playerId).toBe(high); // raw exp ordering: 999999 beats 5 despite lower level

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });
});
