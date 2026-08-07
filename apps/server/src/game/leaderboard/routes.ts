import { LeaderboardKindSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { DEFAULT_LEADERBOARD_PREFIX, topN } from "./service.js";

const ParamsSchema = z.object({ kind: LeaderboardKindSchema });

export function registerLeaderboardRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  leaderboardPrefix = DEFAULT_LEADERBOARD_PREFIX,
): void {
  app.get("/api/leaderboard/:kind", { preHandler: requireAuth }, async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_kind" });

    const entries = await topN(db, redis, params.data.kind, 10, leaderboardPrefix);
    return reply.send({ kind: params.data.kind, entries });
  });
}
