import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { tokenBucket } from "../src/auth/rate-limit.js";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";

// A dedicated Redis client + unique bucket name per test, rather than the
// real "register"/"login" buckets — those are shared (keyed by IP) with
// auth.test.ts and would flake against each other's hit counts.
const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(() => { redis.disconnect(); });

function buildProbeApp(name: string, limit: number, windowSeconds: number): FastifyInstance {
  const app = Fastify({ logger: false });
  app.post("/probe", { preHandler: tokenBucket(redis, { name, limit, windowSeconds }) }, async () => ({ ok: true }));
  return app;
}

describe("tokenBucket", () => {
  it("assigns a TTL to the bucket key on the very first hit (SET NX EX, not INCR-then-EXPIRE)", async () => {
    const name = `test-ttl-${randomUUID()}`;
    const app = buildProbeApp(name, 5, 60);
    const res = await app.inject({ method: "POST", url: "/probe" });
    expect(res.statusCode).toBe(200);

    const ttl = await redis.ttl(`ratelimit:${name}:127.0.0.1`);
    expect(ttl).toBeGreaterThan(0);
    await app.close();
  });

  it("returns 429 with a retry-after header once the limit is exceeded", async () => {
    const name = `test-limit-${randomUUID()}`;
    const app = buildProbeApp(name, 2, 60);

    const first = await app.inject({ method: "POST", url: "/probe" });
    const second = await app.inject({ method: "POST", url: "/probe" });
    const third = await app.inject({ method: "POST", url: "/probe" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "rate_limited" });
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });
});
