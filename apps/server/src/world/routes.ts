import { IdSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { playerStats } from "../db/schema/index.js";
import type { SceneService } from "./scene.js";
import { SCENE_TEMPLATES } from "./templates/index.js";

const ParamsSchema = z.object({ locationId: IdSchema });
const TemplateParamsSchema = z.object({ sceneKey: z.string().min(1).max(64) });

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

  app.get("/api/world/template/:sceneKey", { preHandler: requireAuth }, async (request, reply) => {
    const params = TemplateParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const template = SCENE_TEMPLATES.get(params.data.sceneKey);
    if (template === undefined) return reply.code(404).send({ error: "unknown_template" });
    return reply.send(template);
  });
}
