import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

beforeAll(async () => { await subscriber.subscribe(GAME_EVENTS_CHANNEL); });
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

async function createPlayer(): Promise<{ id: string; username: string }> {
  const id = uuidv7();
  // Whole uuid, not a prefix: uuidv7's leading hex is the millisecond
  // timestamp, so two players minted in the same tick collide on the
  // `players_username_unique` index.
  const username = `pctt${id}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id, username };
}

const deps = (): Parameters<typeof createPluginCtx>[0] =>
  ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: `pctt-test-${uuidv7()}` });
const opts = {
  pluginId: "t", player: null, job: null, filters: [], propertyTypes: new Map(),
  installedPluginIds: new Set<string>(),
};

describe("tx.timers", () => {
  it("get returns null for an absent key", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => {
      expect(await tx.timers.get(player.id, "membership")).toBeNull();
    });
  });

  it("set then get round-trips, set again overwrites", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const first = new Date("2026-09-01T00:00:00.000Z");
    const second = new Date("2026-10-01T00:00:00.000Z");

    await ctx.transaction(async (tx) => {
      await tx.timers.set(player.id, "membership", first);
      expect(await tx.timers.get(player.id, "membership")).toEqual(first);

      await tx.timers.set(player.id, "membership", second);
      expect(await tx.timers.get(player.id, "membership")).toEqual(second);
    });
  });

  it("clear returns true once, then false", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const expiresAt = new Date("2026-09-01T00:00:00.000Z");

    await ctx.transaction(async (tx) => {
      await tx.timers.set(player.id, "membership", expiresAt);
      expect(await tx.timers.clear(player.id, "membership")).toBe(true);
      expect(await tx.timers.clear(player.id, "membership")).toBe(false);
      expect(await tx.timers.get(player.id, "membership")).toBeNull();
    });
  });
});
