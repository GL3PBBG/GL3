import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";
import { createSession, destroyOtherSessions, readSession } from "../src/auth/session.js";

const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(() => { redis.disconnect(); });

describe("destroyOtherSessions", () => {
  it("kills every session of the player except the kept token", async () => {
    const playerId = `sess-test-${Date.now()}`;
    const keep = await createSession(redis, playerId, 60);
    const other1 = await createSession(redis, playerId, 60);
    const other2 = await createSession(redis, playerId, 60);

    await destroyOtherSessions(redis, playerId, keep);

    expect(await readSession(redis, keep)).toBe(playerId);
    expect(await readSession(redis, other1)).toBeNull();
    expect(await readSession(redis, other2)).toBeNull();
    // Reverse index keeps only the survivor.
    expect(await redis.smembers(`playersessions:${playerId}`)).toEqual([keep]);
    await redis.del(`session:${keep}`, `playersessions:${playerId}`);
  });
});
