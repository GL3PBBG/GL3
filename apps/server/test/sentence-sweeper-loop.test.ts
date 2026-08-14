import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { startSentenceSweeper } from "../src/game/sweep/sweeper.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(async () => { await conn.end(); redis.disconnect(); });

beforeEach(async () => { await resetDb(db); });

/** Polls until `check` is true or the deadline passes — no arbitrary sleeps. */
async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("until: condition never became true");
}

describe("startSentenceSweeper", () => {
  it("frees a player with no request from them at all", async () => {
    const id = uuidv7();
    await db.insert(players).values({ id, username: `loop-${id.slice(-8)}` });
    await db.insert(playerStats).values({ playerId: id, jailedUntil: new Date(Date.now() - 1000) });

    const sweeper = startSentenceSweeper({ db, redis, intervalMs: 50 });
    try {
      await until(async () => {
        const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
        return row?.jailedUntil === null;
      });
    } finally {
      sweeper.stop();
    }
  });

  it("keeps ticking after a pass throws", async () => {
    const errors: unknown[] = [];
    // An unreachable Postgres makes the candidate SELECT reject, so EVERY
    // pass throws and the loop has to survive repeatedly. Not a mock — a real
    // driver against a real (refused) socket.
    //
    // Deliberately NOT a broken Redis: createRedis passes
    // `maxRetriesPerRequest: null` and leaves ioredis's offline queue on, so
    // a publish to an unreachable Redis QUEUES FOREVER instead of rejecting,
    // and this test would hang rather than fail.
    const { db: brokenDb, sql: brokenConn } = createDb("postgres://gl3:gl3@127.0.0.1:1/gl3");
    const sweeper = startSentenceSweeper({
      db: brokenDb, redis, intervalMs: 25, onError: (error) => { errors.push(error); },
    });
    try {
      await until(async () => Promise.resolve(errors.length >= 2));
    } finally {
      sweeper.stop();
      await brokenConn.end({ timeout: 1 }).catch(() => undefined);
    }
    // Two errors means the loop survived the first one.
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("stop() halts the loop", async () => {
    const id = uuidv7();
    await db.insert(players).values({ id, username: `stop-${id.slice(-8)}` });
    await db.insert(playerStats).values({ playerId: id });

    const sweeper = startSentenceSweeper({ db, redis, intervalMs: 25 });
    sweeper.stop();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    await new Promise((resolve) => setTimeout(resolve, 200));
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.jailedUntil).not.toBeNull();
  });
});
