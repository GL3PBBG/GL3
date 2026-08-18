import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { listSentencedAtLocation } from "../roster.js";
import { releaseIfExpired } from "./status.js";
import { bailCostPerSecond } from "./settings.js";

export function registerJailRoutes(
  app: FastifyInstance, db: Db, redis: Redis, settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/jail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });
    return reply.send(await releaseIfExpired(db, redis, playerId));
  });

  /** Everyone else's live sentence in the caller's own town. Never lists the caller. */
  app.get("/api/jail/local", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await listSentencedAtLocation(db, playerId, "jail");
    const rate = bailCostPerSecond(settings);
    return reply.send({
      inmates: rows.map((row) => ({
        ...row,
        bailCost: (BigInt(row.remainingSeconds) * rate).toString(),
      })),
    });
  });
}
