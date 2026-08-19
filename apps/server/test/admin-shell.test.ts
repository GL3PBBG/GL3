import { definePlugin } from "@gl3/plugin-sdk";
import { AdminSectionsResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
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
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer({
    plugins: [withAdminPage("alpha"), withAdminPage("beta")],
  }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function register(username: string) {
  return registerVerifiedPlayer({ app, redis }, { username }) as Promise<{ playerId: string; token: string }>;
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

  // The seam that shipped broken once: the route sent manifest `PageSchema`s,
  // which carry no `pluginId` and may carry a `menu` — both fatal to the
  // `.strict()` client schema, so /admin rendered nothing at all. Parsing the
  // real response with the real DTO is the only check that covers it.
  it("serves a payload the client DTO accepts", async () => {
    const founder = await register("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(founder.token) });
    expect(res.statusCode).toBe(200);
    const parsed = AdminSectionsResponseSchema.parse(res.json());
    expect(parsed.sections.map((s) => s.pluginId)).toContain("roles");
    for (const section of parsed.sections) {
      for (const page of section.pages) expect(page.pluginId).toBe(section.pluginId);
    }
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

describe("role creation and module grants", () => {
  it("creates a role with no grants", async () => {
    const founder = await register("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/roles", headers: auth(founder.token),
      payload: { name: "Moderator" },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const table = await app.inject({ method: "GET", url: "/api/admin/roles/table", headers: auth(founder.token) });
    expect(table.json().rows).toContainEqual({ id, name: "Moderator", moduleKeys: "" });
  });

  it("400s an empty role name", async () => {
    const founder = await register("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/roles", headers: auth(founder.token),
      payload: { name: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("offers every loaded plugin id plus roles and the wildcard as modules", async () => {
    const founder = await register("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/roles/modules", headers: auth(founder.token) });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().rows as { id: string }[]).map((r) => r.id);
    // Every loaded plugin, not only the six that happen to have an admin page:
    // a grant is ABAC over the module, and a plugin gaining an admin page must
    // not be the moment its key first becomes grantable.
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
    expect(ids).toContain("bank"); // a core plugin with no adminPages
    expect(ids).toContain("roles");
    expect(ids).toContain("*");
  });

  it("grants a module and the grantee gains exactly that section", async () => {
    const founder = await register("Founder");
    const p = await register("Grantee");
    const create = await app.inject({
      method: "POST", url: "/api/admin/roles", headers: auth(founder.token),
      payload: { name: "BetaAdmin" },
    });
    const roleId = create.json().id as string;

    const grant = await app.inject({
      method: "POST", url: "/api/admin/roles/grants", headers: auth(founder.token),
      payload: { roleId, moduleKey: "beta" },
    });
    expect(grant.statusCode).toBe(204);

    await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Grantee", roleId },
    });
    const sections = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) });
    expect(sections.statusCode).toBe(200);
    expect(sections.json().sections.map((s: { pluginId: string }) => s.pluginId)).toEqual(["beta"]);
  });

  it("is idempotent when the same module is granted twice", async () => {
    const founder = await register("Founder");
    const create = await app.inject({
      method: "POST", url: "/api/admin/roles", headers: auth(founder.token),
      payload: { name: "Twice" },
    });
    const roleId = create.json().id as string;
    for (const _ of [0, 1]) {
      const res = await app.inject({
        method: "POST", url: "/api/admin/roles/grants", headers: auth(founder.token),
        payload: { roleId, moduleKey: "alpha" },
      });
      expect(res.statusCode).toBe(204);
    }
    const rows = await db.select().from(roleModuleAccess).where(eq(roleModuleAccess.roleId, roleId));
    expect(rows).toHaveLength(1);
  });

  it("revokes a module and the grantee loses the section", async () => {
    const founder = await register("Founder");
    const p = await register("Grantee");
    const create = await app.inject({
      method: "POST", url: "/api/admin/roles", headers: auth(founder.token),
      payload: { name: "Temporary" },
    });
    const roleId = create.json().id as string;
    await app.inject({
      method: "POST", url: "/api/admin/roles/grants", headers: auth(founder.token),
      payload: { roleId, moduleKey: "alpha" },
    });
    await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Grantee", roleId },
    });

    const revoke = await app.inject({
      method: "POST", url: "/api/admin/roles/grants/revoke", headers: auth(founder.token),
      payload: { roleId, moduleKey: "alpha" },
    });
    expect(revoke.statusCode).toBe(204);
    const sections = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) });
    expect(sections.statusCode).toBe(403);
  });

  // The lockout this guards: the sole `*` grant lives on the founder's own
  // role, so revoking it strips admin from the only account that can restore
  // it. Same posture as `cannot_demote_self` on assign.
  it("refuses to revoke a grant from the caller's own role", async () => {
    const founder = await register("Founder");
    const [adminRole] = await db.select().from(roles);
    const res = await app.inject({
      method: "POST", url: "/api/admin/roles/grants/revoke", headers: auth(founder.token),
      payload: { roleId: adminRole?.id, moduleKey: "*" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "cannot_revoke_own_role" });
    const rows = await db.select().from(roleModuleAccess)
      .where(eq(roleModuleAccess.roleId, adminRole?.id ?? ""));
    expect(rows.map((r) => r.moduleKey)).toEqual(["*"]);
  });

  it("404s a grant against an unknown role", async () => {
    const founder = await register("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/roles/grants", headers: auth(founder.token),
      payload: { roleId: uuidv7(), moduleKey: "alpha" },
    });
    expect(res.statusCode).toBe(404);
  });

  // A free-string moduleKey would let an admin grant a key no module ever
  // checks — a grant that silently does nothing, indistinguishable from one
  // that works until someone tests it.
  it("400s a grant of a module key no loaded plugin offers", async () => {
    const founder = await register("Founder");
    const create = await app.inject({
      method: "POST", url: "/api/admin/roles", headers: auth(founder.token),
      payload: { name: "Typo" },
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/roles/grants", headers: auth(founder.token),
      payload: { roleId: create.json().id, moduleKey: "gamma" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown_module" });
  });

  it("403s create, grant, revoke and modules for a role without the roles grant", async () => {
    await register("Founder");
    const p = await register("AlphaOnly");
    const roleId = await giveRole(p.playerId, ["alpha"]);
    const cases = [
      { url: "/api/admin/roles", payload: { name: "Sneak" } },
      { url: "/api/admin/roles/grants", payload: { roleId, moduleKey: "beta" } },
      { url: "/api/admin/roles/grants/revoke", payload: { roleId, moduleKey: "alpha" } },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: "POST", url: c.url, headers: auth(p.token), payload: c.payload });
      expect(res.statusCode, c.url).toBe(403);
    }
    const modules = await app.inject({ method: "GET", url: "/api/admin/roles/modules", headers: auth(p.token) });
    expect(modules.statusCode).toBe(403);
  });
});
