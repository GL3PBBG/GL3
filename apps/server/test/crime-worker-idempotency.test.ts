import { GameEventSchema } from "@gl3/shared";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { crimeLog, crimes, playerCrimeSkill, players, playerStats, transactions } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import crimesPlugin from "@gl3/plugin-crimes";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const config = loadConfig(process.env);
const redis = createRedis(config.redisUrl);
const subscriber = createSubscriber(config.redisUrl);

// runPluginJob drives the real plugin handler in-process (no HTTP, no
// boot) with the real plugin_job_runs guard — the same shape a BullMQ
// retry takes.
const deps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "idempotency-test" });

let playerId: string;
let crimeId: string;

beforeEach(async () => {
  await resetDb(db);
  await seedCrimes(db);

  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `idem-${playerId}` });
  await db.insert(playerStats).values({ playerId });

  const [crime] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
  crimeId = crime!.id;

  // Force a deterministic success so the payout is provably credited exactly
  // once, rather than depending on a seed happening to roll a hit.
  await db.insert(playerCrimeSkill).values({ playerId, crimeId, chance: "100.00" });
});

afterAll(async () => {
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("plugin commit job idempotency", () => {
  it("does not double-pay when a BullMQ retry re-runs the same job.id", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const events: unknown[] = [];
    subscriber.on("message", (channel, raw) => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      // `game:events` is a global channel shared by every test file running
      // in parallel — filter on this test's own actor, not just channel
      // name, so a concurrent file's traffic can't be mistaken for the
      // events this job caused (see ws.test.ts for the same discipline).
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.actorId === playerId) events.push(parsed.data);
    });

    const job = {
      id: "retry-test-job-1",
      data: { playerId, crimeId, seed: "fixed-seed-for-idempotency-test" },
    };

    // First attempt: resolves and credits normally.
    await runPluginJob(deps(), crimesPlugin, "commit", job);
    // A BullMQ retry re-runs the whole handler from scratch with the exact
    // same job.id and the exact same seed — seed-determinism means it rolls
    // the identical outcome, but the `plugin_job_runs` idempotency guard
    // (structural, first write inside ctx.transaction) must stop it from
    // crediting a second time. `crime_log.job_id` is still unique but is
    // incidental to that guard, not the mechanism enforcing it.
    await runPluginJob(deps(), crimesPlugin, "commit", job);

    const logs = await db.select().from(crimeLog).where(eq(crimeLog.playerId, playerId));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.jobId).toBe(job.id);

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    expect(ledger).toHaveLength(1);

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBeGreaterThan(0n); // the forced 100% chance guarantees a payout
    expect(stats?.cash).toBe(ledger[0]?.amount); // credited exactly once, matching the one ledger row

    // Give redis pub/sub a moment to deliver the message.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Spec §2: a retried already-committed job emits ONE event, not two.
    // Core republished crime.resolved on replay (worker.ts Decision 1); the
    // plugin framework swallows the replay (JobAlreadyAppliedError aborts the
    // handler before any publishCore), so only the first run's event arrives.
    expect(events).toHaveLength(1);
  });
});

// Task 6: jail-on-failure and rank-up now live inside the same guarded
// transaction as the payout — prove a retry can't double-apply either.
describe("plugin commit job idempotency — jail and rank-up", () => {
  it("does not double-jail on a retried job that fails and rolls jail", async () => {
    // Force a guaranteed jail regardless of the RNG seed: 0% success (so the
    // crime always fails) and a 100% jail chance on that failure.
    await db.update(playerCrimeSkill).set({ chance: "0.00" })
      .where(and(eq(playerCrimeSkill.playerId, playerId), eq(playerCrimeSkill.crimeId, crimeId)));
    await db.update(crimes).set({ jailChancePercent: 100 }).where(eq(crimes.id, crimeId));

    const job = { id: "retry-jail-job-1", data: { playerId, crimeId, seed: "fixed-seed-for-jail-idempotency" } };

    await runPluginJob(deps(), crimesPlugin, "commit", job);
    const [firstStats] = await db.select({ jailedUntil: playerStats.jailedUntil })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(firstStats?.jailedUntil).not.toBeNull();
    const firstUntil = firstStats!.jailedUntil!.getTime();

    // Retry: same job.id, same seed — must NOT re-jail (which would extend
    // or reset the sentence past what the original attempt set).
    await runPluginJob(deps(), crimesPlugin, "commit", job);
    const [secondStats] = await db.select({ jailedUntil: playerStats.jailedUntil })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(secondStats?.jailedUntil?.getTime()).toBe(firstUntil);

    const logs = await db.select().from(crimeLog).where(eq(crimeLog.playerId, playerId));
    expect(logs).toHaveLength(1); // one attempt recorded, not two
  });

  it("does not double-promote or double-pay the rank cash reward on a retried job", async () => {
    const { seedRanks } = await import("../src/db/seed.js");
    await seedRanks(db);

    // beforeEach already forced this player's chance on `crimeId` to 100%.
    // Bump the crime's exp reward so a single successful commit crosses
    // straight from Associate (0 exp) to Soldier (100 exp, 500 cash reward).
    await db.update(crimes).set({ expReward: 150n }).where(eq(crimes.id, crimeId));

    const job = { id: "retry-rank-job-1", data: { playerId, crimeId, seed: "fixed-seed-for-rank-idempotency" } };

    await runPluginJob(deps(), crimesPlugin, "commit", job);
    const [firstStats] = await db.select({ rankId: playerStats.rankId, cash: playerStats.cash })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(firstStats?.rankId).not.toBeNull(); // promoted past the default null rank

    // Retry: same job.id, same seed — must NOT re-promote or re-pay the
    // rank's cash reward a second time.
    await runPluginJob(deps(), crimesPlugin, "commit", job);
    const [secondStats] = await db.select({ rankId: playerStats.rankId, cash: playerStats.cash })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(secondStats?.rankId).toBe(firstStats?.rankId);
    expect(secondStats?.cash).toBe(firstStats?.cash);

    // Exactly one rank.reward ledger row (the crime's own payout is a
    // separate "crime.payout" row) — never doubled by the replay.
    const rankLedger = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, playerId), eq(transactions.reason, "rank.reward")));
    expect(rankLedger).toHaveLength(1);
  });
});
