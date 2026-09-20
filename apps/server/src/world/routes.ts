import { HookRefSchema, IdSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { playerStats } from "../db/schema/index.js";
import type { SceneService } from "./scene.js";
import { SCENE_TEMPLATES } from "./templates/index.js";

const ParamsSchema = z.object({ locationId: IdSchema });
const TemplateParamsSchema = z.object({ sceneKey: z.string().min(1).max(64) });
const InteriorParamsSchema = z.object({ hookId: HookRefSchema });

/**
 * REST face of the scene descriptor (spec 2026-09-17 §1.4) for a client that
 * wants geometry before its socket is up, or wants to preload a destination
 * while a travel request is in flight. None of these routes says who is
 * PRESENT — that is socket-only, so an underground town's residents stay
 * concealed by construction rather than by a filter here.
 */
export function registerWorldRoutes(
  app: FastifyInstance, db: Db, scenes: SceneService,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/world/scene", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });
    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats)
      .where(eq(playerStats.playerId, playerId));
    if (!row?.locationId) return reply.code(404).send({ error: "no_location" });
    const room = await scenes.forLocation(row.locationId);
    if (!room) return reply.code(404).send({ error: "no_location" });
    return reply.send(room);
  });

  app.get("/api/world/scene/:locationId", { preHandler: requireAuth }, async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const room = await scenes.forLocation(params.data.locationId);
    if (!room) return reply.code(404).send({ error: "unknown_location" });
    return reply.send(room);
  });

  /**
   * One door's interior, in the caller's OWN town (spec 2026-09-20
   * casino-interior §4.5). Scoped to where the caller stands for the same
   * reason the street descriptor is: an interior is a view of a town, and a
   * player who is not in it has nothing to enter.
   */
  app.get("/api/world/interior/:hookId", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });
    const params = InteriorParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats)
      .where(eq(playerStats.playerId, playerId));
    if (!row?.locationId) return reply.code(404).send({ error: "no_location" });
    const found = await scenes.forInterior(row.locationId, params.data.hookId);
    // One literal per arm rather than `{ error: found.code }`: the error-code
    // catalog (scripts/error-catalog.mjs) reads literals out of the source, so
    // a code assembled from a variable is invisible to the generated reference
    // and to its drift guard. `no_location` here means the town row itself is
    // gone, not that the caller is nowhere — that is caught above.
    if (!found.ok && found.code === "unknown_hook") return reply.code(404).send({ error: "unknown_hook" });
    if (!found.ok && found.code === "no_interior") return reply.code(404).send({ error: "no_interior" });
    if (!found.ok) return reply.code(404).send({ error: "no_location" });
    return reply.send(found.room);
  });

  app.get("/api/world/template/:sceneKey", { preHandler: requireAuth }, async (request, reply) => {
    const params = TemplateParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const template = SCENE_TEMPLATES.get(params.data.sceneKey);
    if (template === undefined) return reply.code(404).send({ error: "unknown_template" });
    return reply.send(template);
  });
}
