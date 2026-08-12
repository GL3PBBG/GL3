import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import detectivesPlugin from "@gl3/plugin-detectives";
import { loadConfig } from "../src/config.js";
import { detectiveSearches, players, playerStats, pluginJobRuns } from "../src/db/schema/index.js";
import { createRng } from "../src/game/rng.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

// runPluginJob drives the real handler in-process (no HTTP, no boot) with the
// real plugin_job_runs guard — the same shape a BullMQ retry takes
// (crime-worker-idempotency.test.ts is the template).
const deps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "detectives-worker-test" });

let hirerId: string;
let targetId: string;

/** Insert a pending search row directly — the worker doesn't care who hired. */
async function insertSearch(): Promise<string> {
  const id = uuidv7();
  await db.insert(detectiveSearches).values({
    id, playerId: hirerId, targetPlayerId: targetId,
    detectives: 1, endsAt: new Date(Date.now() + 60_000),
  });
  return id;
}

/**
 * Brute-force a seed whose 1×4×1 roll (4%) lands on `want`. Deterministic —
 * createRng is the same sha256 counter stream the worker draws from — and
 * cheap: P(miss 20 times) is negligible for either side of a 4% split.
 */
function findSeed(want: boolean): string {
  for (let i = 0; i < 10_000; i += 1) {
    const seed = `detectives-worker-seed-${i}`;
    if ((createRng(seed).int(0, 100) < 4) === want) return seed;
  }
  throw new Error(`no seed found for want=${want}`);
}

beforeEach(async () => {
  await resetDb(db);
  hirerId = uuidv7();
  targetId = uuidv7();
  await db.insert(players).values([
    { id: hirerId, username: `det-w-h-${hirerId.slice(-8)}` },
    { id: targetId, username: `det-w-t-${targetId.slice(-8)}` },
  ]);
  await db.insert(playerStats).values([{ playerId: hirerId }, { playerId: targetId }]);
});

afterAll(async () => {
  await conn.end();
  redis.disconnect();
});

describe("detectives resolve job", () => {
  it("5 detectives x 5 hours = 100% always succeeds", async () => {
    const searchId = await insertSearch();
    await runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: `det-job-100-${searchId}`,
      // rng.int(0, 100) draws 0..99, so a 100 chance cannot lose — the spec's
      // boundary case (§5).
      data: { searchId, detectives: 5, hours: 5, seed: uuidv7() },
    });
    const [row] = await db.select().from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
    expect(row!.succeeded).toBe(true);
  });

  it("1x1 = 4% roll is the seed's own deterministic draw", async () => {
    for (const want of [true, false]) {
      const seed = findSeed(want);
      const searchId = await insertSearch();
      await runPluginJob(deps(), detectivesPlugin, "resolve", {
        id: `det-job-4pct-${searchId}`,
        data: { searchId, detectives: 1, hours: 1, seed },
      });
      const [row] = await db.select().from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
      expect(row!.succeeded).toBe(want);
    }
  });

  it("a BullMQ retry with the same job id cannot re-roll", async () => {
    // First run resolves to FAILED; the retry carries a seed that WOULD
    // succeed. If the retry re-rolled, the row would flip to true.
    const failSeed = findSeed(false);
    const winSeed = findSeed(true);
    const searchId = await insertSearch();
    const jobId = `det-job-retry-${searchId}`;

    await runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: jobId, data: { searchId, detectives: 1, hours: 1, seed: failSeed },
    });
    // Same job id, different seed — the plugin_job_runs claim must win.
    await runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: jobId, data: { searchId, detectives: 1, hours: 1, seed: winSeed },
    });

    const [row] = await db.select().from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
    expect(row!.succeeded).toBe(false);
    const runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
  });

  it("a search removed between enqueue and resolve is a no-op, not a crash", async () => {
    await expect(runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: "det-job-orphan-1",
      data: { searchId: uuidv7(), detectives: 1, hours: 1, seed: uuidv7() },
    })).resolves.toBeUndefined();
  });
});
