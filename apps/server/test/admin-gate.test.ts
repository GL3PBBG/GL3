import { definePlugin, route } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const testPlugin = definePlugin({
  id: "gatecheck",
  version: "1.0.0",
  basePaths: ["/api/gatecheck", "/api/admin/gatecheck"],
  routes: [
    route({
      method: "GET", path: "/api/admin/gatecheck/ping", auth: "admin",
      handler: async () => ({ status: 200, body: { pong: true } }),
    }),
  ],
});

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  return res.json();
}

async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer({ plugins: [testPlugin] }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("auth: admin gate", () => {
  it("401s with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/gatecheck/ping" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a player with no role", async () => {
    // First-registered player auto-becomes admin (Task 6) — register a
    // sacrificial first user, then test with the second.
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("NoRole");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("403s a role granting a different module", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("MailMod");
    await giveRole(p.playerId, "mail");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("200s an exact module grant", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("GateMod");
    await giveRole(p.playerId, "gatecheck");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  it("200s a * wildcard grant", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("Wildcard");
    await giveRole(p.playerId, "*");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
