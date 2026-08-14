import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats, ranks } from "../src/db/schema/index.js";
import { dischargeIfExpired } from "../src/game/hospital/status.js";
import { releaseIfExpiredWithOutcome } from "../src/game/jail/status.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

/** A player with a rank whose max health is 140, so a restore is visible. */
async function makePlayer(): Promise<string> {
  const id = uuidv7();
  // uuidv7's leading hex is a timestamp and collides across fast inserts —
  // slice the random tail, same as hospital-status.test.ts.
  await db.insert(players).values({ id, username: `sw-${id.slice(-8)}` });
  const rankId = uuidv7();
  // `0n` in an INSERT value, not sql`0` — the sql`` form is only needed for
  // bigint COLUMN DEFAULTS, which drizzle-kit's serialiser crashes on.
  await db.insert(ranks).values({
    id: rankId, name: `r-${rankId.slice(-8)}`, expRequired: 0n, maxHealth: 140,
  });
  await db.insert(playerStats).values({ playerId: id, health: 100, rankId });
  return id;
}

describe("release helpers report their own claim", () => {
  beforeEach(async () => {
    await resetDb(db);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
  });

  it("releaseIfExpiredWithOutcome reports released=true exactly once", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const event = awaitOwnEvent(subscriber, id);
    const first = await releaseIfExpiredWithOutcome(db, redis, id);
    expect(first.released).toBe(true);
    expect(first.status.jailed).toBe(false);
    expect((await event).type).toBe("player.released");

    const second = await releaseIfExpiredWithOutcome(db, redis, id);
    expect(second.released).toBe(false);
  });

  it("releaseIfExpiredWithOutcome reports released=false while the sentence runs", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, id));

    const outcome = await releaseIfExpiredWithOutcome(db, redis, id);
    expect(outcome.released).toBe(false);
    expect(outcome.status.jailed).toBe(true);
  });

  it("dischargeIfExpired restores health, publishes player.discharged, and claims once", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const event = awaitOwnEvent(subscriber, id);
    const first = await dischargeIfExpired(db, redis, id);
    expect(first.discharged).toBe(true);
    expect((await event).type).toBe("player.discharged");

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(140);
    expect(row?.hospitalUntil).toBeNull();

    const second = await dischargeIfExpired(db, redis, id);
    expect(second.discharged).toBe(false);
  });

  it("dischargeIfExpired leaves a live sentence alone", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, id));

    const outcome = await dischargeIfExpired(db, redis, id);
    expect(outcome.discharged).toBe(false);
    expect(outcome.status.hospitalised).toBe(true);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(0);
  });
});

describe("sentence expiry indexes", () => {
  it("indexes both expiry columns partially, so the sweep never seq-scans", async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'player_stats'
        AND indexname IN ('player_stats_jailed_until_idx', 'player_stats_hospital_until_idx')
      ORDER BY indexname
    `);
    const found = [...rows].map((r) => r.indexname);
    expect(found).toEqual(["player_stats_hospital_until_idx", "player_stats_jailed_until_idx"]);
    // Partial, not full: the WHERE clause is the whole point.
    for (const row of rows) expect(row.indexdef.toLowerCase()).toContain("where");
  });
});
