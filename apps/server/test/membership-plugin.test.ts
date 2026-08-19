import membershipPlugin, { isMember, membershipUntil } from "@gl3/plugin-membership";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, describe, expect, it } from "vitest";
import { players, playerStats } from "../src/db/schema/index.js";
import { loadConfig } from "../src/config.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis } from "../src/redis.js";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(async () => { await conn.end(); redis.disconnect(); });

describe("membership migrations", () => {
  it("creates p_membership_packages", async () => {
    await runPluginMigrations(db, [membershipPlugin]);
    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables WHERE tablename = 'p_membership_packages'`);
    expect(tables).toHaveLength(1);
  });
});

async function createPlayer(): Promise<{ id: string }> {
  const id = uuidv7();
  // Whole uuid, not a prefix: uuidv7's leading hex is the millisecond
  // timestamp, so two players minted in the same tick collide on the
  // `players_username_unique` index (see plugin-tx-timers.test.ts).
  const username = `mship${id}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id };
}

const deps = (): Parameters<typeof createPluginCtx>[0] =>
  ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: `mship-test-${uuidv7()}` });
const opts = {
  pluginId: "membership", player: null, job: null, filters: [], propertyTypes: new Map(),
  installedPluginIds: new Set<string>(),
};

async function notificationCount(playerId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS count FROM notifications WHERE player_id = ${playerId}`);
  return Number(rows[0]?.count ?? 0);
}

describe("membershipUntil / isMember", () => {
  it("returns the live expiry for a live timer", async () => {
    const player = await createPlayer();
    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() + interval '1 hour')`);

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      const until = await membershipUntil(tx, player.id);
      expect(until).toBeInstanceOf(Date);
      expect(await isMember(tx, player.id)).toBe(true);
    });
  });

  it("expires lazily: deletes the row and sends exactly one notification", async () => {
    const player = await createPlayer();
    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() - interval '1 hour')`);

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
    });

    const remaining = await db.execute(sql`
      SELECT 1 FROM player_timers WHERE player_id = ${player.id} AND key = 'membership'`);
    expect(remaining).toHaveLength(0);
    expect(await notificationCount(player.id)).toBe(1);
  });

  it("a second call after expiry stays null and sends no further notification", async () => {
    const player = await createPlayer();
    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() - interval '1 hour')`);

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
    });
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
      expect(await isMember(tx, player.id)).toBe(false);
    });

    expect(await notificationCount(player.id)).toBe(1);
  });

  it("no row at all returns null and sends no notification", async () => {
    const player = await createPlayer();

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
      expect(await isMember(tx, player.id)).toBe(false);
    });

    expect(await notificationCount(player.id)).toBe(0);
  });
});
