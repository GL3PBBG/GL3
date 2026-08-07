import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { acquireCooldown, cooldownKey, peekCooldown, releaseCooldown } from "../src/game/cooldown.js";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";

const redis = createRedis(loadConfig(process.env).redisUrl);
const key = cooldownKey("018f8e2a-0000-7000-8000-000000000002", "crime");

beforeEach(async () => { await redis.del(key); });
afterAll(() => { redis.disconnect(); });

describe("cooldowns", () => {
  it("builds a namespaced key", () => {
    expect(key).toBe("cooldown:crime:018f8e2a-0000-7000-8000-000000000002");
  });

  it("grants the first acquire and denies the second", async () => {
    expect(await acquireCooldown(redis, key, 60)).toBe(true);
    expect(await acquireCooldown(redis, key, 60)).toBe(false);
  });

  it("grants exactly one winner under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => acquireCooldown(redis, key, 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("reports remaining seconds and 0 when free", async () => {
    expect(await peekCooldown(redis, key)).toBe(0);
    await acquireCooldown(redis, key, 60);
    expect(await peekCooldown(redis, key)).toBeGreaterThan(0);
  });

  it("releases so a compensating path can retry immediately", async () => {
    await acquireCooldown(redis, key, 60);
    await releaseCooldown(redis, key);
    expect(await acquireCooldown(redis, key, 60)).toBe(true);
  });
});
