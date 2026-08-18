import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players } from "../src/db/schema/index.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, redis, close: closeServer } = await bootTestServer());
});
afterAll(async () => { await closeServer(); await conn.end(); });

/**
 * Reset tokens land in Redis as `pwreset:<token>` -> playerId. Same scanning
 * trick as verifyCodeFor, but for the reset namespace, and scoped to a
 * specific playerId since a forgot call for an unverified player must issue
 * no token at all (there's nothing to scan FOR, so the caller checks absence).
 */
async function resetTokenFor(client: Redis, playerId: string): Promise<string | null> {
  const keys = await client.keys("pwreset:*");
  for (const key of keys) {
    if ((await client.get(key)) === playerId) return key.slice("pwreset:".length);
  }
  return null;
}

describe("POST /api/auth/forgot", () => {
  it("returns 200 for unknown and known emails alike", async () => {
    const unknown = await app.inject({
      method: "POST", url: "/api/auth/forgot",
      payload: { email: "nobody@example.test" },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({});

    const email = `known_${Date.now()}@example.test`;
    await registerVerifiedPlayer({ app, redis }, { email });
    const known = await app.inject({
      method: "POST", url: "/api/auth/forgot",
      payload: { email },
    });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({});
  });

  it("invalid body also answers 200 with no enumeration signal", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/forgot",
      payload: { email: "not-an-email" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
});

describe("password reset", () => {
  it("verified player can reset; old password dies, sessions die", async () => {
    const { username, playerId } = await registerVerifiedPlayer({ app, redis }, { password: "oldpassword1" });

    // Two live sessions for the same player: login again for a second token.
    const secondLogin = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username, password: "oldpassword1" },
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondToken = secondLogin.json().token as string;

    const firstMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${secondToken}` } });
    expect(firstMe.statusCode).toBe(200);

    const [registered] = await db.select({ email: players.email }).from(players).where(eq(players.id, playerId));
    const email = registered!.email!;

    const forgot = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email } });
    expect(forgot.statusCode).toBe(200);

    const token = await resetTokenFor(redis, playerId);
    expect(token).not.toBeNull();

    const reset = await app.inject({
      method: "POST", url: "/api/auth/reset",
      payload: { token, password: "brandnewpassword1" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({});

    // Old sessions are dead.
    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${secondToken}` } });
    expect(meAfter.statusCode).toBe(401);

    // Old password no longer authenticates.
    const oldLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "oldpassword1" } });
    expect(oldLogin.statusCode).toBe(401);

    // New password does.
    const newLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "brandnewpassword1" } });
    expect(newLogin.statusCode).toBe(200);
  });

  it("unverified email receives no reset token", async () => {
    const email = `unverified_${Date.now()}@example.test`;
    const register = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `uv_${Date.now()}`, email, password: "password123" },
    });
    expect(register.statusCode).toBe(201);
    const { playerId } = register.json() as { playerId: string };

    const forgot = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email } });
    expect(forgot.statusCode).toBe(200);

    const token = await resetTokenFor(redis, playerId);
    expect(token).toBeNull();
  });

  it("reset token is single-use", async () => {
    const { playerId } = await registerVerifiedPlayer({ app, redis }, { password: "originalpass1" });
    const [registered] = await db.select({ email: players.email }).from(players).where(eq(players.id, playerId));
    const email = registered!.email!;

    await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email } });
    const token = await resetTokenFor(redis, playerId);
    expect(token).not.toBeNull();

    const first = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "newpassword12" } });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "anotherpassword" } });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual({ error: "invalid_token" });
  });

  it("400 invalid_token on an unknown token", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/reset",
      payload: { token: "not-a-real-token-at-all", password: "somepassword1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_token" });
  });
});
