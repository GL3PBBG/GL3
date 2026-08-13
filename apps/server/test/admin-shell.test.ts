import { definePlugin } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const withAdminPage = (id: string) => definePlugin({
  id, version: "1.0.0", basePaths: [`/api/${id}`, `/api/admin/${id}`],
  adminPages: [{
    id: `${id}-admin`, path: `/admin/${id}`,
    view: { kind: "panel", title: id, children: [{ kind: "text", value: id }] },
  }],
});

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer({
    plugins: [withAdminPage("alpha"), withAdminPage("beta")],
  }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function register(username: string) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  return res.json() as { playerId: string; token: string };
}

async function giveRole(playerId: string, moduleKeys: string[]): Promise<string> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKeys.join("-")}` });
  for (const moduleKey of moduleKeys) {
    await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  }
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
  return roleId;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("GET /api/admin/plugins", () => {
  it("403s a player with no grants", async () => {
    await register("Founder");
    const p = await register("Nobody");
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) });
    expect(res.statusCode).toBe(403);
  });

  it("returns only the granted plugin's section for a narrow role", async () => {
    await register("Founder");
    const p = await register("AlphaOnly");
    await giveRole(p.playerId, ["alpha"]);
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.map((s: { pluginId: string }) => s.pluginId)).toEqual(["alpha"]);
  });

  it("returns all sections plus the core roles section for *", async () => {
    const founder = await register("Founder"); // auto-admin with *
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(founder.token) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().sections.map((s: { pluginId: string }) => s.pluginId);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
    expect(ids).toContain("roles");
  });

  it("a plugin not loaded contributes no section", async () => {
    const founder = await register("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(founder.token) });
    const ids = res.json().sections.map((s: { pluginId: string }) => s.pluginId);
    expect(ids).not.toContain("gamma"); // never loaded — feature absent
  });
});

describe("role management", () => {
  it("lists roles with their module keys", async () => {
    const founder = await register("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/roles", headers: auth(founder.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual([
      expect.objectContaining({ name: "Administrator", moduleKeys: ["*"] }),
    ]);
  });

  it("lists roles table-source endpoint", async () => {
    const founder = await register("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/roles/table", headers: auth(founder.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0]).toEqual(
      expect.objectContaining({ name: "Administrator", moduleKeys: "*" }),
    );
  });

  it("assigns and clears a role by username", async () => {
    const founder = await register("Founder");
    const p = await register("Promotee");
    const [adminRole] = await db.select().from(roles);
    const assign = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Promotee", roleId: adminRole?.id },
    });
    expect(assign.statusCode).toBe(204);
    const clear = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Promotee", roleId: null },
    });
    expect(clear.statusCode).toBe(204);
    const [row] = await db.select({ roleId: players.roleId }).from(players)
      .where(eq(players.id, p.playerId));
    expect(row?.roleId).toBeNull();
  });

  it("refuses self-modification", async () => {
    const founder = await register("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Founder", roleId: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "cannot_demote_self" });
  });

  it("404s an unknown username and an unknown roleId", async () => {
    const founder = await register("Founder");
    const ghost = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Nobody", roleId: null },
    });
    expect(ghost.statusCode).toBe(404);
    // Use a different registered user (not Founder) so the self-check
    // doesn't fire before the roleId existence check.
    await register("Target");
    const badRole = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Target", roleId: uuidv7() },
    });
    expect(badRole.statusCode).toBe(404);
  });

  it("403s role routes for a role without the roles grant", async () => {
    await register("Founder");
    const p = await register("AlphaOnly");
    await giveRole(p.playerId, ["alpha"]);
    const res = await app.inject({ method: "GET", url: "/api/admin/roles", headers: auth(p.token) });
    expect(res.statusCode).toBe(403);
  });
});
