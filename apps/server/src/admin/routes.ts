import { hasPermission, type PluginManifest } from "@gl3/plugin-sdk";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { players, roleModuleAccess, roles } from "../db/schema/index.js";
import type { PagePayload } from "../plugins/manifest-endpoint.js";
import { loadGrants } from "../plugins/routes.js";
import { rolesPage } from "./roles-page.js";

const AssignBodySchema = z.object({
  username: z.string().min(1),
  roleId: z.union([z.string().uuid(), z.literal(""), z.null()]).transform((v) => (v === "" ? null : v)),
}).strict();

const CreateRoleBodySchema = z.object({
  // Trimmed before the length check, not after: "   " is an empty name typed
  // into a text input, and a role listed as blank cannot be told apart from
  // any other blank role in the assign select.
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1)),
}).strict();

const GrantBodySchema = z.object({
  roleId: z.string().uuid(),
  moduleKey: z.string().min(1),
}).strict();

/** The `*` wildcard's label, kept out of the select's value — the value stays `*`. */
const WILDCARD_LABEL = "* (every module)";

/**
 * Every key `hasPermission` can be asked about: one per loaded plugin, plus
 * core's own `roles` module and the `*` wildcard.
 *
 * Derived from the loaded manifests rather than from the subset with
 * `adminPages`, because a grant is ABAC over the module — plugin routes call
 * `hasPermission(grants, <pluginId>)` whether or not the plugin also ships an
 * admin page, and a plugin gaining one later must not be the moment its key
 * first becomes grantable.
 */
function moduleKeysOf(manifests: readonly PluginManifest[]): { id: string; name: string }[] {
  const pluginIds = manifests.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  return [
    { id: "*", name: WILDCARD_LABEL },
    { id: "roles", name: "roles" },
    ...pluginIds.map((id) => ({ id, name: id })),
  ];
}

export function registerAdminRoutes(
  app: FastifyInstance, db: Db, manifests: readonly PluginManifest[],
): void {
  // requireAuth is decorated by registerAuthRoutes, which app.ts runs first.
  // The grant check is two inline lines per handler on purpose: a helper
  // hiding reply.code(403) behind a return value reads worse than the
  // repetition.

  app.get("/api/admin/plugins", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    // Field-by-field copy, never a spread of the manifest page: the client
    // parses this with `AdminSectionsResponseSchema`, whose page schema is
    // `.strict()` and requires `pluginId` — which a `PageSchema` does not
    // carry, while its optional `menu` is a key strict would reject. Same
    // shape as manifest-endpoint.ts's `/api/plugins` pages.
    const sections: { pluginId: string; pages: PagePayload[] }[] = [];
    for (const manifest of manifests) {
      if (manifest.adminPages.length === 0) continue;
      if (!hasPermission(grants, manifest.id)) continue;
      sections.push({
        pluginId: manifest.id,
        pages: manifest.adminPages.map((p) => ({
          pluginId: manifest.id, id: p.id, path: p.path, view: p.view,
        })),
      });
    }
    if (hasPermission(grants, "roles")) {
      sections.push({
        pluginId: "roles",
        pages: [{ pluginId: "roles", id: rolesPage.id, path: rolesPage.path, view: rolesPage.view }],
      });
    }
    if (sections.length === 0) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ sections });
  });

  app.get("/api/admin/roles", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const roleRows = await db.select().from(roles);
    const accessRows = await db.select().from(roleModuleAccess);
    const byRole = new Map<string, string[]>();
    for (const row of accessRows) {
      const list = byRole.get(row.roleId) ?? [];
      list.push(row.moduleKey);
      byRole.set(row.roleId, list);
    }
    return reply.send({
      roles: roleRows.map((r) => ({ id: r.id, name: r.name, moduleKeys: byRole.get(r.id) ?? [] })),
    });
  });

  // Table-source twin of GET /api/admin/roles: pre-stringified rows.
  app.get("/api/admin/roles/table", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const roleRows = await db.select().from(roles);
    const accessRows = await db.select().from(roleModuleAccess);
    const byRole = new Map<string, string[]>();
    for (const row of accessRows) {
      const list = byRole.get(row.roleId) ?? [];
      list.push(row.moduleKey);
      byRole.set(row.roleId, list);
    }
    return reply.send({
      rows: roleRows.map((r) => ({
        id: r.id, name: r.name, moduleKeys: (byRole.get(r.id) ?? []).join(", "),
      })),
    });
  });

  app.post("/api/admin/roles/assign", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = AssignBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [target] = await db.select({ id: players.id }).from(players)
      .where(eq(players.username, parsed.data.username));
    if (!target) return reply.code(404).send({ error: "player_not_found" });
    if (target.id === playerId) {
      return reply.code(400).send({ error: "cannot_demote_self" });
    }
    if (parsed.data.roleId !== null) {
      const [role] = await db.select({ id: roles.id }).from(roles)
        .where(eq(roles.id, parsed.data.roleId));
      if (!role) return reply.code(404).send({ error: "role_not_found" });
    }
    await db.update(players).set({ roleId: parsed.data.roleId }).where(eq(players.id, target.id));
    return reply.code(204).send();
  });

  // Table-source shape (`{ rows }`), not `{ modules }`: it feeds a `select`
  // field's `optionsSource`, which parses every response with
  // TableRowsResponseSchema regardless of what it is listing.
  app.get("/api/admin/roles/modules", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ rows: moduleKeysOf(manifests) });
  });

  app.post("/api/admin/roles", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = CreateRoleBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const id = uuidv7();
    // Created with no grants on purpose: a role that could be born holding `*`
    // would make "create" a second, unaudited path to full admin.
    await db.insert(roles).values({ id, name: parsed.data.name });
    return reply.code(201).send({ id });
  });

  app.post("/api/admin/roles/grants", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = GrantBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    // Checked against the loaded manifests, not accepted as a free string: a
    // key no module ever asks about is a grant that silently does nothing,
    // indistinguishable from one that works until someone tests it.
    const known = moduleKeysOf(manifests).some((m) => m.id === parsed.data.moduleKey);
    if (!known) return reply.code(400).send({ error: "unknown_module" });

    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, parsed.data.roleId));
    if (!role) return reply.code(404).send({ error: "role_not_found" });

    await db.insert(roleModuleAccess)
      .values({ roleId: parsed.data.roleId, moduleKey: parsed.data.moduleKey })
      .onConflictDoNothing();
    return reply.code(204).send();
  });

  app.post("/api/admin/roles/grants/revoke", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = GrantBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, parsed.data.roleId));
    if (!role) return reply.code(404).send({ error: "role_not_found" });

    // The lockout this exists to stop: the only `*` grant sits on the founder's
    // own role, so revoking it strips admin from the one account that could
    // restore it. Rejecting the caller's *own role* — not just `*` — also keeps
    // an admin from cutting off the module they are standing in.
    const [self] = await db.select({ roleId: players.roleId }).from(players).where(eq(players.id, playerId));
    if (self?.roleId === parsed.data.roleId) {
      return reply.code(400).send({ error: "cannot_revoke_own_role" });
    }

    await db.delete(roleModuleAccess).where(and(
      eq(roleModuleAccess.roleId, parsed.data.roleId),
      eq(roleModuleAccess.moduleKey, parsed.data.moduleKey),
    ));
    return reply.code(204).send();
  });
}
