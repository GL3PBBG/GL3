import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/auth/password.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";
import { verifyCodeFor } from "./helpers/verify.js";

const { db, sql: conn } = testDb();
// Same idiom as leaderboard.test.ts / bounties-lock-order.test.ts: bootTestServer
// doesn't expose the Redis client it wires into the app, so tests that need to
// read Redis directly (here, to recover a verify code the log mail driver only
// prints to stdout) open their own client against the same REDIS_URL.
const redis: Redis = createRedis(loadConfig(process.env).redisUrl);

let app: FastifyInstance;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});
afterAll(async () => { await closeServer(); await conn.end(); redis.disconnect(); });

describe("email verification hard gate", () => {
  it("registers with email, is gated, verifies, plays", async () => {
    const register = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `v_${Date.now()}`, email: `v${Date.now()}@x.com`, password: "password123" },
    });
    expect(register.statusCode).toBe(201);
    const { token, playerId } = register.json();

    // gated: a game route 403s with the specific code
    const gated = await app.inject({ method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${token}` } });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().error).toBe("email_unverified");

    // exempt: me still answers
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);

    // exempt: an unverified player can still mint a WS ticket — the events
    // socket carries nothing gated, and this is what stops the client's own
    // /verify-page gate redirect from looping against itself.
    const ticket = await app.inject({ method: "POST", url: "/api/ws/ticket", headers: { authorization: `Bearer ${token}` } });
    expect(ticket.statusCode).toBe(201);

    const code = await verifyCodeFor(redis, playerId);
    const verify = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { code } });
    expect(verify.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(200);
  });

  it("verify code is single-use", async () => {
    const register = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `su_${Date.now()}`, email: `su${Date.now()}@x.com`, password: "password123" },
    });
    const { playerId } = register.json();
    const code = await verifyCodeFor(redis, playerId);

    const first = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { code } });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { code } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("invalid_code");
  });

  it("registration without email is a 400", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `x_${Date.now()}`, password: "password123" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("grandfathered player (email_verified_at set) is never gated", async () => {
    const playerId = uuidv7();
    const username = `gf_${Date.now()}`;
    await db.insert(players).values({
      id: playerId,
      username,
      email: `gf${Date.now()}@x.com`,
      passwordHash: await hashPassword("password123"),
      emailVerifiedAt: sql`now()`,
    });
    await db.insert(playerStats).values({ playerId });

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
    expect(login.statusCode).toBe(200);
    const { token } = login.json();

    const gated = await app.inject({ method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${token}` } });
    expect(gated.statusCode).toBe(200);
  });

  it("login re-asserts the unverified flag after a Redis flush of the key", async () => {
    const register = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `re_${Date.now()}`, email: `re${Date.now()}@x.com`, password: "password123" },
    });
    const { playerId, username } = register.json();

    // Simulate the Redis flag going missing without the player ever verifying.
    await redis.del(`unverified:${playerId}`);
    const stillUnverified = await db.select({ emailVerifiedAt: players.emailVerifiedAt })
      .from(players).where(eq(players.id, playerId));
    expect(stillUnverified[0]?.emailVerifiedAt).toBeNull();

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
    expect(login.statusCode).toBe(200);
    const { token } = login.json();

    const gated = await app.inject({ method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${token}` } });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().error).toBe("email_unverified");
  });
});

describe("POST /api/auth/verify/resend", () => {
  it("re-issues a working code and rejects an already-verified player", async () => {
    const register = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `rs_${Date.now()}`, email: `rs${Date.now()}@x.com`, password: "password123" },
    });
    const { token, playerId } = register.json();

    // Discard the register-issued code without consuming it via the verify
    // route, so only resend's code exists the next time we scan for one —
    // resend doesn't invalidate a prior code, and two live codes for the same
    // player would make the scan in verifyCodeFor ambiguous.
    const registerCode = await verifyCodeFor(redis, playerId);
    await redis.del(`emailverify:${registerCode}`);

    const resend = await app.inject({ method: "POST", url: "/api/auth/verify/resend", headers: { authorization: `Bearer ${token}` } });
    expect(resend.statusCode).toBe(200);

    const code = await verifyCodeFor(redis, playerId);
    const verify = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { code } });
    expect(verify.statusCode).toBe(200);

    const again = await app.inject({ method: "POST", url: "/api/auth/verify/resend", headers: { authorization: `Bearer ${token}` } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_verified");
  });

  it("401s without a session", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/verify/resend" });
    expect(res.statusCode).toBe(401);
  });
});
