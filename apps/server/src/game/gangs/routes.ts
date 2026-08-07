import { count, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { CreateGangRequestSchema, IdSchema, type GameEvent } from "@gl3/shared";
import { z } from "zod";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { gangLogs, gangMembers, gangs, playerStats, players } from "../../db/schema/index.js";
import { lockPlayersForUpdate } from "../../economy/ledger.js";
import { appendGangLog } from "./logs.js";

export const GangParamsSchema = z.object({ gangId: IdSchema });

/**
 * Thrown inside the create-gang transaction when the row-locked recheck
 * finds the player already gang-bound. A plain pre-check-then-act SELECT
 * before the transaction let two concurrent POSTs from the same player both
 * pass the check before either committed, producing two gangs and an
 * orphaned one — see NOTES.md rule 2. Locking playerStats via
 * lockPlayersForUpdate (the same primitive applyBalanceChange uses) and
 * re-checking inside the transaction closes that window.
 */
class AlreadyInGangError extends Error {
  constructor(readonly playerId: string) {
    super(`player ${playerId} already in a gang`);
    this.name = "AlreadyInGangError";
  }
}

function uniqueViolation(err: unknown): postgres.PostgresError | null {
  const candidate = err instanceof postgres.PostgresError ? err
    : err instanceof Error && err.cause instanceof postgres.PostgresError ? err.cause
    : null;
  return candidate?.code === "23505" ? candidate : null;
}

async function loadGangDto(db: Db, gangId: string): Promise<Record<string, unknown> | null> {
  const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
  if (!gang) return null;
  const [memberCount] = await db.select({ n: count() }).from(gangMembers).where(eq(gangMembers.gangId, gangId));
  return {
    id: gang.id, name: gang.name, description: gang.description, info: gang.info,
    bank: gang.bank.toString(), cash: gang.cash.toString(), level: gang.level,
    bossPlayerId: gang.bossPlayerId, underbossPlayerId: gang.underbossPlayerId,
    memberCount: memberCount?.n ?? 0,
  };
}

export function registerGangRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post("/api/gangs", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = CreateGangRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    const gangId = uuidv7();
    try {
      await db.transaction(async (tx) => {
        // Lock this player's stats row first, then recheck under that lock —
        // the window between an unlocked pre-check and this transaction's
        // commit is exactly what let two concurrent requests both pass.
        await lockPlayersForUpdate(tx, [playerId]);
        const [existing] = await tx.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, playerId));
        if (existing?.gangId) throw new AlreadyInGangError(playerId);

        await tx.insert(gangs).values({
          id: gangId, name: parsed.data.name, description: parsed.data.description ?? "",
          info: parsed.data.info ?? "", bossPlayerId: playerId,
        });
        await tx.insert(gangMembers).values({ gangId, playerId });
        await tx.update(playerStats).set({ gangId }).where(eq(playerStats.playerId, playerId));
        await appendGangLog(tx, gangId, playerId, "founded the gang");
      });
    } catch (err) {
      if (err instanceof AlreadyInGangError) return reply.code(409).send({ error: "already_in_a_gang" });
      if (uniqueViolation(err)?.constraint_name === "gangs_name_unique") {
        return reply.code(409).send({ error: "gang_name_taken" });
      }
      throw err;
    }

    const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
    const event: GameEvent = {
      id: uuidv7(), type: "gang.created", at: new Date().toISOString(),
      actorId: playerId, actorName: actor?.username ?? "unknown", audience: { kind: "gang", gangId },
      gangId, gangName: parsed.data.name,
    };
    await publishEvent(redis, event);

    const dto = await loadGangDto(db, gangId);
    return reply.code(201).send(dto);
  });

  app.get("/api/gangs/:gangId", { preHandler: requireAuth }, async (request, reply) => {
    const params = GangParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const dto = await loadGangDto(db, params.data.gangId);
    if (!dto) return reply.code(404).send({ error: "gang_not_found" });
    return reply.send(dto);
  });

  app.get("/api/gangs/:gangId/logs", { preHandler: requireAuth }, async (request, reply) => {
    const params = GangParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const rows = await db.select().from(gangLogs)
      .where(eq(gangLogs.gangId, params.data.gangId))
      .orderBy(desc(gangLogs.createdAt))
      .limit(50);

    return reply.send({
      logs: rows.map((l) => ({ id: l.id, playerId: l.playerId, message: l.message, createdAt: l.createdAt.toISOString() })),
    });
  });
}
