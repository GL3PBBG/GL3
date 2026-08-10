import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { cooldownKey } from "../src/game/cooldown.js";
import { loadConfig } from "../src/config.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { createRedis } from "../src/redis.js";

const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(() => { redis.disconnect(); });

// Redis is shared across every concurrently-running test file; a shared
// `leaderboard:*` key would let two files see each other's scores.
const leaderboardPrefix = `cooldown-test-${randomUUID()}`;

const ctxFor = (pluginId: string) => createPluginCtx(
  { db: undefined as never, redis, queues: new Map(), settings: { "hello.greeting": "hi" }, leaderboardPrefix },
  { pluginId, player: null, job: null, filters: [] },
);

describe("ctx.cooldown", () => {
  it("writes the byte-identical key the core helper uses", async () => {
    const playerId = randomUUID();
    await ctxFor("hello").cooldown.acquire("hello-greet", playerId, 30);
    // If the SDK invented its own key format, a ported module would stop
    // sharing a cooldown with the client's countdown and with any core code
    // still reading it during the strangler window.
    expect(await redis.ttl(cooldownKey(playerId, "hello-greet"))).toBeGreaterThan(0);
  });

  it("refuses a second acquire inside the window", async () => {
    const playerId = randomUUID();
    const ctx = ctxFor("hello");
    expect(await ctx.cooldown.acquire("greet", playerId, 30)).toBe(true);
    expect(await ctx.cooldown.acquire("greet", playerId, 30)).toBe(false);
  });

  it("reports 0 for a cooldown that was never set", async () => {
    expect(await ctxFor("hello").cooldown.peek("greet", randomUUID())).toBe(0);
  });

  it("re-allows the action after release", async () => {
    const playerId = randomUUID();
    const ctx = ctxFor("hello");
    await ctx.cooldown.acquire("greet", playerId, 30);
    await ctx.cooldown.release("greet", playerId);
    expect(await ctx.cooldown.acquire("greet", playerId, 30)).toBe(true);
  });
});

describe("ctx.settings", () => {
  it("reads only this plugin's namespace", () => {
    expect(ctxFor("hello").settings.get("greeting")).toBe("hi");
    expect(ctxFor("other").settings.get("greeting")).toBeNull();
  });
});
