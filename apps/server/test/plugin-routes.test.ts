import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

const testPlugin = definePlugin({
  id: "rt",
  version: "1.0.0",
  basePaths: ["/api/rt"],
  routes: [
    route({
      method: "GET",
      path: "/api/rt/open",
      auth: "public",
      handler: async () => ({ status: 200, body: { ok: true } }),
    }),
    route({
      method: "GET",
      path: "/api/rt/me",
      handler: async (ctx) => ({ status: 200, body: { playerId: ctx.player?.id ?? null } }),
    }),
    route({
      method: "POST",
      path: "/api/rt/act",
      accessInJail: false,
      handler: async () => ({ status: 204 }),
    }),
    route({
      method: "POST",
      path: "/api/rt/items/:itemId",
      params: z.object({ itemId: z.string().uuid() }),
      body: z.object({ amount: z.number().int().positive() }),
      handler: async (_ctx, { params, body }) => ({ status: 200, body: { ...params, ...body } }),
    }),
    route({
      method: "GET",
      path: "/api/rt/boom",
      handler: async () => { throw new PluginError("too_poor", 409, { need: "500" }); },
    }),
  ],
});

let app: FastifyInstance;
let closeServer: () => Promise<void>;

let regCounter = 0;

/** Register a player and return { token, playerId } — inline because no shared factories file exists. */
async function register(target: FastifyInstance): Promise<{ token: string; playerId: string }> {
  regCounter++;
  const reg = await target.inject({
    method: "POST",
    url: "/api/auth/register",
    // Distinct IP per registration to keep this file's rate-limit bucket private.
    remoteAddress: `10.20.${regCounter >> 8 & 0xff}.${regCounter & 0xff}`,
    payload: {
      username: `RTUser${regCounter}`,
      password: "hunter2hunter2",
    },
  });
  return reg.json();
}

beforeAll(async () => {
  ({ app, close: closeServer } = await bootTestServer({ plugins: [testPlugin] }));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("plugin routes", () => {
  it("serves a public route without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/rt/open" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("401s an authed route without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/rt/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("exposes the authenticated player on ctx", async () => {
    const { token, playerId } = await register(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/rt/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()).toEqual({ playerId });
  });

  it("returns the exact core jail response on accessInJail: false", async () => {
    const { token, playerId } = await register(app);
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future }).where(eq(playerStats.playerId, playerId));
    const res = await app.inject({
      method: "POST",
      url: "/api/rt/act",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "jailed" });
    expect(typeof res.json().remainingSeconds).toBe("number");
  });

  it("400s an invalid uuid param before it reaches Postgres", async () => {
    const { token } = await register(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/rt/items/not-a-uuid",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("400s an invalid body", async () => {
    const { token } = await register(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/rt/items/01920000-0000-7000-8000-000000000000",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("maps PluginError to its declared status and extra fields", async () => {
    const { token } = await register(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/rt/boom",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "too_poor", need: "500" });
  });
});
