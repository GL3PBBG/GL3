import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { clientIp, tokenBucket } from "../src/auth/rate-limit.js";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";

// A dedicated Redis client + unique bucket name per test, rather than the
// real "register"/"login" buckets — those are shared (keyed by IP) with
// auth.test.ts and would flake against each other's hit counts.
const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(() => { redis.disconnect(); });

function buildProbeApp(name: string, limit: number, windowSeconds: number, ipHeader?: string | null): FastifyInstance {
  const app = Fastify({ logger: false });
  app.post("/probe", { preHandler: tokenBucket(redis, { name, limit, windowSeconds, ipHeader }) }, async () => ({ ok: true }));
  return app;
}

type FakeRequest = { ip: string; headers: Record<string, string | string[] | undefined> };
const fakeRequest = (headers: FakeRequest["headers"] = {}): FakeRequest => ({ ip: "10.0.0.1", headers });

describe("clientIp", () => {
  it("returns request.ip when no header is configured", () => {
    expect(clientIp(fakeRequest({ "cf-connecting-ip": "203.0.113.9" }), null)).toBe("10.0.0.1");
  });

  it("returns the configured header's value when present", () => {
    expect(clientIp(fakeRequest({ "cf-connecting-ip": "203.0.113.9" }), "cf-connecting-ip")).toBe("203.0.113.9");
  });

  it("matches the header case-insensitively as configured", () => {
    // Fastify lowercases incoming header names; the CONFIG value may be typed
    // in any case and must still match.
    expect(clientIp(fakeRequest({ "cf-connecting-ip": "203.0.113.9" }), "CF-Connecting-IP")).toBe("203.0.113.9");
  });

  it("falls back to request.ip when the configured header is absent or blank", () => {
    expect(clientIp(fakeRequest(), "cf-connecting-ip")).toBe("10.0.0.1");
    expect(clientIp(fakeRequest({ "cf-connecting-ip": "  " }), "cf-connecting-ip")).toBe("10.0.0.1");
  });

  it("takes the first entry of a multi-value or comma-separated header", () => {
    expect(clientIp(fakeRequest({ "x-forwarded-for": "203.0.113.9, 198.51.100.2" }), "x-forwarded-for")).toBe("203.0.113.9");
    expect(clientIp(fakeRequest({ "x-forwarded-for": ["203.0.113.9", "198.51.100.2"] }), "x-forwarded-for")).toBe("203.0.113.9");
  });
});

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

  it("buckets by the configured client-IP header, not the socket address", async () => {
    const name = `test-header-${randomUUID()}`;
    const app = buildProbeApp(name, 1, 60, "cf-connecting-ip");

    // Two clients behind the same tunnel socket: separate buckets each.
    const a1 = await app.inject({ method: "POST", url: "/probe", headers: { "cf-connecting-ip": "203.0.113.9" } });
    const b1 = await app.inject({ method: "POST", url: "/probe", headers: { "cf-connecting-ip": "203.0.113.10" } });
    const a2 = await app.inject({ method: "POST", url: "/probe", headers: { "cf-connecting-ip": "203.0.113.9" } });

    expect(a1.statusCode).toBe(200);
    expect(b1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);

    const ttl = await redis.ttl(`ratelimit:${name}:203.0.113.9`);
    expect(ttl).toBeGreaterThan(0);
    await app.close();
  });
});
