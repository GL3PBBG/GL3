import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { createTicket } from "../auth/session.js";

/**
 * Mints the short-lived, single-use ticket the gateway's `/ws` upgrade
 * requires in place of the session token (SPEC §2.2). Behind `requireAuth`
 * so only an already-authenticated caller can obtain one.
 */
export function registerWsRoutes(
  app: FastifyInstance, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post("/api/ws/ticket", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const ticket = await createTicket(redis, playerId);
    return reply.code(201).send({ ticket });
  });
}
