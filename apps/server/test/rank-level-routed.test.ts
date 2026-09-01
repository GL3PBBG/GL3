import { eq } from "drizzle-orm";
import { encodeLevelScore } from "@gl3/shared";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { players, playerStats, ranks, transactions } from "../src/db/schema/index.js";
import { seedRanks } from "../src/db/seed.js";
import { collectAssetSlots } from "../src/plugins/asset-slots.js";
import { collectAttributePools } from "../src/plugins/attribute-pools.js";
import { bundledPlugins } from "../src/plugins/core-plugins.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { collectExpRouters } from "../src/plugins/exp-routers.js";
import { loadPlugins, type LoadedPlugins } from "../src/plugins/loader.js";
import { createRedis } from "../src/redis.js";
import { testAssetDriver } from "./helpers/assets.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

afterAll(async () => {
  await conn.end();
  redis.disconnect();
});

async function createPlayer(): Promise<{ id: string; username: string }> {
  const id = uuidv7();
  const username = `rlr${id}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id, username };
}

/**
 * Loads a profile's plugin bundle onto the shared test DB/Redis (the
 * `ranks.test.ts` "GET /api/ranks" precedent: `loadPlugins` direct, not the
 * whole `bootTestServer` app) and builds a plugin ctx wired exactly the way
 * `plugins/routes.ts` wires one per request — `collectAttributePools` /
 * `collectExpRouters` / `collectAssetSlots` over the SAME manifests the
 * loader resolved, so a `gl3`-profile ctx sees progression's real
 * `applyExp` claim, not a stand-in.
 */
async function bootCtx(profile: "gl3" | "v2"): Promise<{
  ctx: ReturnType<typeof createPluginCtx>;
  leaderboardPrefix: string;
  plugins: LoadedPlugins;
}> {
  const manifests = bundledPlugins(profile, []);
  const leaderboardPrefix = `rank-level-routed-${profile}-${uuidv7()}`;
  const deps = {
    db, redis, settings: {}, leaderboardPrefix, assetDriver: testAssetDriver(),
  };
  const plugins = await loadPlugins(deps, manifests, `rlr-${profile}-${uuidv7()}-`, profile);
  const ctx = createPluginCtx(
    { ...deps, queues: plugins.queues },
    {
      pluginId: "rlr-test",
      player: null,
      job: null,
      filters: [],
      propertyTypes: new Map(),
      attributePools: collectAttributePools(manifests),
      expRouter: collectExpRouters(manifests),
      installedPluginIds: new Set(manifests.map((m) => m.id)),
      assetSlots: collectAssetSlots(manifests),
    },
  );
  return { ctx, leaderboardPrefix, plugins };
}

async function closePlugins(plugins: LoadedPlugins): Promise<void> {
  for (const w of plugins.workers) await w.close();
  for (const q of plugins.queues.values()) await q.close();
}

async function statsOf(playerId: string) {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!row) throw new Error(`player_stats missing for ${playerId}`);
  return row;
}

describe("routed exp promotion (gl3 profile: progression claims the router)", () => {
  let plugins: LoadedPlugins;
  let ctx: ReturnType<typeof createPluginCtx> extends infer T ? T : never;
  let leaderboardPrefix: string;
  let playerId: string;
  let username: string;
  let soldierId: string;

  beforeAll(async () => {
    await resetDb(db);
    await seedRanks(db);
    // Ladder order is expRequired ascending (Associate 0, Soldier 100, Capo
    // 500, Underboss 2000, Boss 8000) — position 1 is Soldier, the target a
    // level-2 ordinal maps onto (syncRankToLevel's `min(level, count) - 1`).
    const ladder = await db.select().from(ranks).orderBy(ranks.expRequired);
    soldierId = ladder[1]!.id;
    const boot = await bootCtx("gl3");
    plugins = boot.plugins;
    ctx = boot.ctx;
    leaderboardPrefix = boot.leaderboardPrefix;
    const player = await createPlayer();
    playerId = player.id;
    username = player.username;
  });
  afterAll(async () => {
    await closePlugins(plugins);
  });

  // MCCodes' exp-needed curve (progression/src/index.ts's `expNeeded`,
  // mirrored inline per the plan rather than imported across packages):
  // `floor((level + 1)^3 * 2.2)`. A fresh player starts at level 1
  // (player_stats.level default), so the level-1->2 crossing needs
  // floor(2^3 * 2.2) = floor(17.6) = 17 exp.
  const expNeeded = (level: number): bigint => BigInt(Math.trunc(Math.pow(level + 1, 3) * 2.2));

  it("case 1: a crossing grant promotes by level ordinal and pays the target rank's reward", async () => {
    const grant = expNeeded(1); // 17n — crosses level 1 -> 2 in one grant, no further

    // The event assertion took the brief's sanctioned fallback: a real-time
    // `game:events` pub/sub watch here proved unreliable under the full
    // sweep's load (a genuine ioredis subscriber reconnect drops an
    // in-flight message with no redelivery — Redis PUBLISH has no queue for
    // a momentarily-disconnected subscriber), while every assertion below
    // — including the non-null promotion this event is conditioned on —
    // passed both standalone and under the sweep. `tx.events.publishCore`
    // is still exercised here (mirroring crimes' own caller-publish
    // pattern), just not asserted-observed; the corresponding envelope
    // shape IS covered, unconditionally, by
    // plugin-ctx-core-events.test.ts's CORPUS entry for "player.rankedUp".
    const promotion = await ctx.transaction(async (tx) => {
      const result = await tx.economy.applyExpAndRankUp(playerId, grant);
      if (result) {
        await tx.events.publishCore({
          type: "player.rankedUp",
          actorId: playerId,
          actorName: username,
          audience: { kind: "player", playerId },
          rankId: result.rankId,
          rankName: result.rankName,
          cashReward: result.cashReward.toString(),
          bulletReward: result.bulletReward.toString(),
          maxHealth: result.maxHealth,
        });
      }
      return result;
    });

    // Non-null return: this is the routed arm's whole contract change —
    // before this task it always returned null.
    expect(promotion).not.toBeNull();
    expect(promotion?.rankId).toBe(soldierId);
    // Seeded Soldier reward (db/seed.ts's seedRanks): 500 cash, 5 bullets.
    expect(promotion?.cashReward).toBe(500n);
    expect(promotion?.bulletReward).toBe(5);

    const stats = await statsOf(playerId);
    expect(stats.level).toBe(2);
    expect(stats.rankId).toBe(soldierId);
    expect(stats.cash).toBe(500n);
    expect(stats.bullets).toBe(5n);

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    const rewardRows = ledger.filter((r) => r.reason === "rank.reward");
    expect(rewardRows).toHaveLength(1);
    expect(rewardRows[0]?.amount).toBe(500n);
  });

  it("case 2: a non-crossing grant leaves level and rank untouched and returns null", async () => {
    const before = await statsOf(playerId);

    const promotion = await ctx.transaction((tx) => tx.economy.applyExpAndRankUp(playerId, 1n));

    expect(promotion).toBeNull();
    const after = await statsOf(playerId);
    expect(after.level).toBe(before.level);
    expect(after.rankId).toBe(before.rankId);
    expect(after.cash).toBe(before.cash);

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    expect(ledger.filter((r) => r.reason === "rank.reward")).toHaveLength(1); // still just case 1's row
  });

  it("case 3: the buffered exp score is the level-composite, not raw exp", async () => {
    const stats = await statsOf(playerId);
    const score = await redis.zscore(`${leaderboardPrefix}:exp`, playerId);
    expect(score).toBe(encodeLevelScore(stats.level, stats.exp).toString());
  });
});

describe("unrouted exp promotion (v2 profile: no exp-routing claimant)", () => {
  let plugins: LoadedPlugins;
  let ctx: ReturnType<typeof createPluginCtx> extends infer T ? T : never;
  let leaderboardPrefix: string;
  let playerId: string;
  let soldierId: string;

  beforeAll(async () => {
    await resetDb(db);
    await seedRanks(db);
    const ladder = await db.select().from(ranks).orderBy(ranks.expRequired);
    soldierId = ladder[1]!.id;
    const boot = await bootCtx("v2"); // v2 boots keep the historical merge — no progression plugin, no router
    plugins = boot.plugins;
    ctx = boot.ctx;
    leaderboardPrefix = boot.leaderboardPrefix;
    const player = await createPlayer();
    playerId = player.id;
  });
  afterAll(async () => {
    await closePlugins(plugins);
  });

  it("case 4: promotion is threshold-based (exp_required) and the ZSET score is raw exp", async () => {
    // Straight past Associate (0) to Soldier (100): ranks.test.ts's own
    // "promotes ... on crossing a threshold" case, replayed through the
    // ctx wrapper rather than economy/ranks.ts directly.
    const promotion = await ctx.transaction((tx) => tx.economy.applyExpAndRankUp(playerId, 150n));

    expect(promotion?.rankId).toBe(soldierId);
    expect(promotion?.cashReward).toBe(500n);

    const stats = await statsOf(playerId);
    // No level column involvement at all in the unrouted arm.
    expect(stats.level).toBe(1);
    expect(stats.rankId).toBe(soldierId);
    expect(stats.exp).toBe(150n);

    const score = await redis.zscore(`${leaderboardPrefix}:exp`, playerId);
    expect(score).toBe("150"); // raw exp, not encodeLevelScore(1, 150n)
  });
});
