import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { crimeLog, crimes, playerCrimeSkill, players, playerStats, transactions } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { processCrimeJob } from "../src/game/crimes/worker.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const config = loadConfig(process.env);
const publisher = createRedis(config.redisUrl);
const subscriber = createSubscriber(config.redisUrl);

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
  publisher.disconnect();
  subscriber.disconnect();
});

describe("processCrimeJob idempotency", () => {
  it("does not double-pay when a BullMQ retry re-runs the same job.id", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const events: unknown[] = [];
    subscriber.on("message", (channel, raw) => {
      if (channel === GAME_EVENTS_CHANNEL) events.push(JSON.parse(raw));
    });

    const job = {
      id: "retry-test-job-1",
      data: { playerId, crimeId, seed: "fixed-seed-for-idempotency-test" },
    };

    // First attempt: resolves and credits normally.
    await processCrimeJob(db, publisher, job);
    // A BullMQ retry re-runs the whole handler from scratch with the exact
    // same job.id and the exact same seed — seed-determinism means it rolls
    // the identical outcome, but the crime_log.job_id unique index must stop
    // it from crediting a second time.
    await processCrimeJob(db, publisher, job);

    const logs = await db.select().from(crimeLog).where(eq(crimeLog.playerId, playerId));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.jobId).toBe(job.id);

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    expect(ledger).toHaveLength(1);

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBeGreaterThan(0n); // the forced 100% chance guarantees a payout
    expect(stats?.cash).toBe(ledger[0]?.amount); // credited exactly once, matching the one ledger row

    // Decision 1 (see worker.ts): the retry still republishes the event,
    // because the retry exists precisely to cover the case where the first
    // attempt committed and then died before publishing. Give redis pub/sub
    // a moment to deliver both messages.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(2);
  });
});
