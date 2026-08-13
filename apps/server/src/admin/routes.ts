import { hasPermission, type PageSchema, type PluginManifest } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { players, roleModuleAccess, roles } from "../db/schema/index.js";
import { loadGrants } from "../plugins/routes.js";
import { rolesPage } from "./roles-page.js";

const AssignBodySchema = z.object({
  username: z.string().min(1),
  roleId: z.union([z.string().uuid(), z.literal(""), z.null()]).transform((v) => (v === "" ? null : v)),
}).strict();

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
    const sections: { pluginId: string; pages: PageSchema[] }[] = [];
    for (const manifest of manifests) {
      if (manifest.adminPages.length === 0) continue;
      if (!hasPermission(grants, manifest.id)) continue;
      sections.push({ pluginId: manifest.id, pages: manifest.adminPages });
    }
    if (hasPermission(grants, "roles")) {
      sections.push({ pluginId: "roles", pages: [rolesPage] });
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
}
