import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
