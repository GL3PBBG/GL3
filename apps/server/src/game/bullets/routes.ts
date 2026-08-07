import { BuyBulletsRequestSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { InsufficientFundsError } from "../../economy/ledger.js";
import { releaseIfExpired } from "../jail/status.js";
import { InsufficientStockError, NoLocationError, performBulletsPurchase } from "./service.js";

export function registerBulletsRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post("/api/bullets/buy", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const jail = await releaseIfExpired(db, redis, playerId);
    if (jail.jailed) {
      reply.header("retry-after", String(jail.remainingSeconds));
      return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
    }

    const parsed = BuyBulletsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    try {
      const result = await performBulletsPurchase(db, redis, playerId, parsed.data.quantity);
      return reply.send(result);
    } catch (err) {
      if (err instanceof NoLocationError) return reply.code(409).send({ error: "no_location" });
      if (err instanceof InsufficientStockError) return reply.code(409).send({ error: "insufficient_stock", available: err.available });
      if (err instanceof InsufficientFundsError) return reply.code(409).send({ error: "insufficient_funds" });
      throw err;
    }
  });
}
