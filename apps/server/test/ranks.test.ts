import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyExpAndRankUp } from "../src/economy/ranks.js";
import { players, playerStats, ranks, transactions } from "../src/db/schema/index.js";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let playerId: string;
let soldierId: string;
let associateId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, health: 90 });

  associateId = uuidv7();
  soldierId = uuidv7();
  await db.insert(ranks).values([
    { id: associateId, name: "Associate", expRequired: 0n, cashReward: 0n, bulletReward: 0, maxHealth: 100 },
    { id: soldierId, name: "Soldier", expRequired: 100n, cashReward: 500n, bulletReward: 5, maxHealth: 110 },
  ]);
});
afterAll(async () => { await conn.end(); redis.disconnect(); });

describe("applyExpAndRankUp", () => {
  it("does nothing when expGain is 0", async () => {
    const result = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 0n));
    expect(result).toBeNull();
    const [row] = await db.select({ rankId: playerStats.rankId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.rankId).toBeNull();
  });

  it("adds exp without a rank change when still short of the next threshold", async () => {
    const result = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 5n));
    expect(result?.rankId).toBe(associateId); // qualifies for Associate (0 exp) on the very first grant
    const second = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 5n)); // total 10, still < 100
    expect(second).toBeNull();
  });

  it("promotes, credits the cash reward as a ledger row, and raises max health on crossing a threshold", async () => {
    const result = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 150n)); // straight past Associate to Soldier
    expect(result).toEqual({ rankId: soldierId, rankName: "Soldier", cashReward: 500n, bulletReward: 5, maxHealth: 110 });

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.rankId).toBe(soldierId);
    expect(stats?.cash).toBe(500n);
    expect(stats?.bullets).toBe(5n);
    expect(stats?.health).toBe(110);
    expect(stats?.exp).toBe(150n);

    const ledger = await db.select().from(transactions);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.reason).toBe("rank.reward");
  });

  it("does not re-promote or re-credit once already at the qualifying rank", async () => {
    await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 150n));
    const again = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 1n)); // 151 exp, still Soldier
    expect(again).toBeNull();
    const [stats] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBe(500n); // unchanged — no second reward
  });
});

describe("GET /api/ranks", () => {
  it("lists the ladder with the player's current rank flagged", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");
    const { seedRanks } = await import("../src/db/seed.js");
    // beforeEach already inserted its own 2-rank fixture; seedRanks is
    // idempotent (no-ops when any row exists), so clear just the ranks
    // table to get the full 5-rank ladder this test asserts on. A targeted
    // delete instead of the file's resetDb(): resetDb() TRUNCATEs every
    // game table (players, transactions, crimes, items, ...) CASCADE, which
    // measured ~2.3s of this test's ~5s budget under load — almost all of
    // it spent re-clearing tables this test never touches. playerStats.rankId
    // is `ON DELETE SET NULL` (see schema/identity.ts), so deleting ranks
    // rows here can't violate any FK; nothing else needs clearing since
    // beforeEach's playerId/playerStats fixture is untouched (still rankId:
    // null) and this test registers its own separate player via HTTP.
    await db.delete(ranks);
    await seedRanks(db);

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const leaderboardPrefix = `ranks-test-${uuidv7()}`;
    const loadedPlugins = await loadPlugins(
      { db, redis, settings: {}, leaderboardPrefix },
      withCorePlugins([]),
      `plugin-ranks-test-${uuidv7()}-`,
    );
    const app = await buildApp(config, { db, redis, leaderboardPrefix, plugins: loadedPlugins });
    const { token } = await registerVerifiedPlayer({ app, redis }, { username: `Rank${Date.now()}` });

    const res = await app.inject({ method: "GET", url: "/api/ranks", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const { ranks: list } = res.json();
    expect(list).toHaveLength(5);
    expect(list.every((r: { current: boolean }) => r.current === false)).toBe(true); // no exp yet

    await app.close();
    for (const w of loadedPlugins.workers) await w.close();
    for (const q of loadedPlugins.queues.values()) await q.close();
  });
});
