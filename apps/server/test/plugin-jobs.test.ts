import { definePlugin } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { players, playerStats, transactions } from "../src/db/schema/index.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { createRedis } from "../src/redis.js";
import { testDb } from "./helpers/db.js";

// testDb() returns createDb's { db, sql } pair, NOT a drizzle db — using it as
// one fails with `Cannot read properties of undefined (reading
// 'Symbol(drizzle:Columns)')`. There is no testRedis helper anywhere in this
// repo; Redis comes from createRedis(loadConfig(...).redisUrl), the shape
// test/bank.test.ts:13-15 already uses.
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

afterAll(async () => { await conn.end(); redis.disconnect(); });

// There is no test/helpers/factories.ts in this repo. Every existing test
// builds a player the way bank.test.ts:21-22 does: a `players` row plus its
// `playerStats` row, which is where every balance actually lives.
async function createPlayer(cash: bigint): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insert(players).values({ id, username: `pjobs${id.slice(0, 8)}` });
  await db.insert(playerStats).values({ playerId: id, cash });
  return { id };
}

const deps = () => ({ db, redis, queues: new Map(), settings: {} });

const paying = definePlugin({
  id: "pay", version: "1.0.0", basePaths: ["/api/pay"],
  jobs: {
    payout: async (ctx, data) => {
      await ctx.transaction(async (tx) => {
        await tx.locks.player([String(data["playerId"])]);
        await tx.economy.applyBalanceChange({
          playerId: String(data["playerId"]), amount: 100n, kind: "cash", reason: "plugin_payout",
        });
      });
    },
  },
});

describe("plugin jobs", () => {
  it("applies a retried job exactly once", async () => {
    const player = await createPlayer(0n);
    const jobId = randomUUID();
    const job = { id: jobId, data: { playerId: player.id, seed: "abcdef" } };

    await runPluginJob(deps(), paying, "payout", job);
    // BullMQ is at-least-once: this is a retry of a job that already committed.
    await runPluginJob(deps(), paying, "payout", job);

    const rows = await db.select().from(transactions).where(eq(transactions.playerId, player.id));
    expect(rows).toHaveLength(1);
  });

  it("gives the handler a deterministic rng derived from the job seed", async () => {
    const seen: number[] = [];
    const rolling = definePlugin({
      id: "roll", version: "1.0.0", basePaths: ["/api/roll"],
      jobs: { roll: async (ctx) => { seen.push(ctx.job?.rng.int(0, 1000) ?? -1); } },
    });
    await runPluginJob(deps(), rolling, "roll", { id: randomUUID(), data: { seed: "deadbeef" } });
    await runPluginJob(deps(), rolling, "roll", { id: randomUUID(), data: { seed: "deadbeef" } });
    expect(seen[0]).toBe(seen[1]);
  });

  it("throws on an unknown job name rather than silently succeeding", async () => {
    await expect(runPluginJob(deps(), paying, "nope", { id: randomUUID(), data: {} }))
      .rejects.toThrow(/nope/);
  });
});
