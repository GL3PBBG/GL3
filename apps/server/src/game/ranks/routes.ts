import { asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { playerStats, ranks } from "../../db/schema/index.js";

export function registerRankRoutes(
  app: FastifyInstance, db: Db,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/ranks", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const [player] = await db.select({ rankId: playerStats.rankId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    const rows = await db.select().from(ranks).orderBy(asc(ranks.expRequired));

    return reply.send({
      ranks: rows.map((r) => ({
        id: r.id, name: r.name, expRequired: r.expRequired.toString(),
        cashReward: r.cashReward.toString(), bulletReward: r.bulletReward, maxHealth: r.maxHealth,
        current: r.id === player?.rankId,
      })),
    });
  });
}
