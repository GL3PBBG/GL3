import { asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { IdSchema } from "@gl3/shared";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { crimes, playerCrimeSkill } from "../../db/schema/index.js";
import { acquireCooldown, cooldownKey, peekCooldown, releaseCooldown } from "../cooldown.js";
import { newSeed } from "../rng.js";
import type { CrimeJobData } from "../../queue/index.js";

/** V2 shipped a default ladder starting at 35% (spec §1.2 US_crimes default string). */
export const DEFAULT_CRIME_CHANCE = "35.00";

const CommitCrimeParamsSchema = z.object({ crimeId: IdSchema });

export function registerCrimeRoutes(
  app: FastifyInstance, db: Db, redis: Redis, queue: Queue<CrimeJobData>,
  // The brief's literal `reply: never` doesn't type-check as a preHandler param
  // (FastifyReply isn't assignable to never) — using the real reply type instead,
  // matching what auth/routes.ts's requireAuth actually is at runtime.
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/crimes", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await db.select().from(crimes).orderBy(asc(crimes.sort));
    const skills = await db.select().from(playerCrimeSkill).where(eq(playerCrimeSkill.playerId, playerId));
    const skillByCrime = new Map(skills.map((s) => [s.crimeId, s.chance]));
    const remaining = await peekCooldown(redis, cooldownKey(playerId, "crime"));

    return reply.send({
      crimes: rows.map((crime) => ({
        id: crime.id,
        name: crime.name,
        description: crime.description,
        cooldownSeconds: crime.cooldownSeconds,
        minPayout: crime.minPayout.toString(),
        maxPayout: crime.maxPayout.toString(),
        chance: skillByCrime.get(crime.id) ?? DEFAULT_CRIME_CHANCE,
        cooldownRemaining: remaining,
      })),
    });
  });

  app.post("/api/crimes/:crimeId/commit", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsedParams = CommitCrimeParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return reply.code(400).send({ error: "invalid_request" });
    const { crimeId } = parsedParams.data;

    // Look the crime up BEFORE claiming the cooldown so a typo costs nothing.
    const [crime] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    if (!crime) return reply.code(404).send({ error: "crime_not_found" });

    const key = cooldownKey(playerId, "crime");
    const won = await acquireCooldown(redis, key, crime.cooldownSeconds);
    if (!won) {
      const retryAfter = await peekCooldown(redis, key);
      reply.header("retry-after", String(Math.max(retryAfter, 1)));
      return reply.code(429).send({ error: "on_cooldown", retryAfter });
    }

    try {
      const job = await queue.add("commit", { playerId, crimeId, seed: newSeed() });
      return reply.code(202).send({ jobId: job.id ?? "", accepted: true });
    } catch (error) {
      try {
        await releaseCooldown(redis, key); // don't strand the player behind a cooldown
      } catch (releaseError) {
        // If the compensating release itself throws, letting it replace `error`
        // would lose the diagnostic for the real failure AND still leave the
        // cooldown stuck — the exact outcome this catch exists to prevent.
        // Log and swallow so the original enqueue error always propagates.
        request.log.error(
          { err: releaseError, playerId, crimeId },
          "failed to release cooldown after enqueue failure",
        );
      }
      throw error;
    }
  });
}
