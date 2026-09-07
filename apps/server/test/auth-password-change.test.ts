import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /api/auth/password", () => {
  it("401 without a session", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/password", payload: { currentPassword: "a", newPassword: "longenough1" } });
    expect(res.statusCode).toBe(401);
  });

  it("401 invalid_credentials on a wrong current password, nothing changes", async () => {
    const { token, username } = await registerVerifiedPlayer({ app, redis }, { password: "oldpassword1" });
    const res = await app.inject({ method: "POST", url: "/api/auth/password", headers: auth(token), payload: { currentPassword: "nope", newPassword: "brandnewpass1" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "oldpassword1" } });
    expect(login.statusCode).toBe(200);
  });

  it("400 invalid_request on a short new password", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis }, { password: "oldpassword1" });
    const res = await app.inject({ method: "POST", url: "/api/auth/password", headers: auth(token), payload: { currentPassword: "oldpassword1", newPassword: "short" } });
    expect(res.statusCode).toBe(400);
  });

  it("changes the password, keeps the caller's session, kills every other", async () => {
    const { token, username } = await registerVerifiedPlayer({ app, redis }, { password: "oldpassword1" });
    const second = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "oldpassword1" } });
    const secondToken = second.json().token as string;

    const res = await app.inject({ method: "POST", url: "/api/auth/password", headers: auth(token), payload: { currentPassword: "oldpassword1", newPassword: "brandnewpass1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(secondToken) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "oldpassword1" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "brandnewpass1" } })).statusCode).toBe(200);
  });

  it("an unverified player can still change their password (gate-exempt)", async () => {
    const username = `uv_${Date.now()}`;
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username, email: `${username}@example.test`, password: "oldpassword1", acceptTerms: true } });
    expect(reg.statusCode).toBe(201);
    const token = reg.json().token as string;
    const res = await app.inject({ method: "POST", url: "/api/auth/password", headers: auth(token), payload: { currentPassword: "oldpassword1", newPassword: "brandnewpass1" } });
    expect(res.statusCode).toBe(200);
  });
});
