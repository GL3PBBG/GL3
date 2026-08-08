import { IdSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { locations, playerStats } from "../../db/schema/index.js";
import { InsufficientFundsError } from "../../economy/ledger.js";
import { acquireCooldown, cooldownKey, peekCooldown, releaseCooldown } from "../cooldown.js";
import { releaseIfExpired } from "../jail/status.js";
import { AlreadyAtLocationError, LocationNotFoundError, performTravel } from "./service.js";

const TravelParamsSchema = z.object({ locationId: IdSchema });

export function registerTravelRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/locations", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const [player] = await db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    const rows = await db.select().from(locations);
    const remaining = await peekCooldown(redis, cooldownKey(playerId, "travel"));

    return reply.send({
      locations: rows.map((l) => ({
        id: l.id, name: l.name, travelCost: l.travelCost.toString(), travelCooldownSeconds: l.travelCooldownSeconds,
        bulletCost: l.bulletCost.toString(), bulletStock: l.bulletStock,
        current: l.id === player?.locationId, cooldownRemaining: remaining,
      })),
    });
  });

  app.post("/api/travel/:locationId", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const jail = await releaseIfExpired(db, redis, playerId);
    if (jail.jailed) {
      reply.header("retry-after", String(jail.remainingSeconds));
      return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
    }

    const params = TravelParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const { locationId } = params.data;

    // Look the location up BEFORE claiming the cooldown so a typo costs nothing.
    const [destination] = await db.select({ travelCooldownSeconds: locations.travelCooldownSeconds }).from(locations).where(eq(locations.id, locationId));
    if (!destination) return reply.code(404).send({ error: "location_not_found" });

    const key = cooldownKey(playerId, "travel");
    const won = await acquireCooldown(redis, key, destination.travelCooldownSeconds);
    if (!won) {
      const retryAfter = await peekCooldown(redis, key);
      reply.header("retry-after", String(Math.max(retryAfter, 1)));
      return reply.code(429).send({ error: "on_cooldown", retryAfter });
    }

    try {
      const result = await performTravel(db, redis, playerId, locationId);
      return reply.send(result);
    } catch (err) {
      try {
        await releaseCooldown(redis, key); // don't strand the player behind a cooldown they never used
      } catch (releaseError) {
        request.log.error({ err: releaseError, playerId, locationId }, "failed to release travel cooldown after failure");
      }
      if (err instanceof LocationNotFoundError) return reply.code(404).send({ error: "location_not_found" });
      if (err instanceof AlreadyAtLocationError) return reply.code(409).send({ error: "already_there" });
      if (err instanceof InsufficientFundsError) return reply.code(409).send({ error: "insufficient_funds" });
      throw err;
    }
  });
}
