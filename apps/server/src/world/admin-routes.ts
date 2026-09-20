import { hasPermission } from "@gl3/plugin-sdk";
import { DEFAULT_SCENE_KEY, IdSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { locations, locationScenes } from "../db/schema/index.js";
import { loadGrants } from "../plugins/routes.js";
import { SCENE_TEMPLATES } from "./templates/index.js";

const PutSceneSchema = z.object({ locationId: IdSchema, sceneKey: z.string().min(1).max(64) }).strict();

/**
 * Admin section for spec 2026-09-20 §5: which authored scene each town runs
 * on. Shape copied from `legal/routes.ts` — grant-gated reads and a write,
 * no lock taken anywhere (the write is one upsert outside any player
 * transaction, so it adds no lock-graph edge).
 */
export function registerWorldAdminRoutes(app: FastifyInstance, db: Db): void {
  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const playerId = request.playerId;
    if (playerId === undefined) {
      await reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "world")) {
      await reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  };

  app.get("/api/admin/world/scenes", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (!(await guard(request, reply))) return;
    const rows = await db.select({ id: locations.id, name: locations.name, sceneKey: locationScenes.sceneKey })
      .from(locations).leftJoin(locationScenes, eq(locationScenes.locationId, locations.id)).orderBy(locations.name);
    return reply.send({ rows: rows.map((r) => ({ id: r.id, name: r.name, sceneKey: r.sceneKey ?? DEFAULT_SCENE_KEY })) });
  });

  app.get("/api/admin/world/templates", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (!(await guard(request, reply))) return;
    return reply.send({ rows: [DEFAULT_SCENE_KEY, ...SCENE_TEMPLATES.keys()].map((k) => ({ id: k, name: k })) });
  });

  app.put("/api/admin/world/scene", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (!(await guard(request, reply))) return;
    const body = PutSceneSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const key = body.data.sceneKey;
    if (key !== DEFAULT_SCENE_KEY && !SCENE_TEMPLATES.has(key)) return reply.code(400).send({ error: "invalid_scene_key" });
    const [town] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, body.data.locationId));
    if (!town) return reply.code(404).send({ error: "unknown_location" });
    // One row, outside any player transaction: no lock edge (rule 6).
    await db.insert(locationScenes).values({ locationId: town.id, sceneKey: key })
      .onConflictDoUpdate({ target: locationScenes.locationId, set: { sceneKey: key } });
    return reply.send({});
  });
}
