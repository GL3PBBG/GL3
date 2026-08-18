import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, InsufficientFundsError, lockPlayersForUpdate } from "../../economy/ledger.js";
import { insertNotification } from "../notifications/service.js";
import { listSentencedAtLocation } from "../roster.js";
import { releaseIfExpired } from "./status.js";
import { bailCostPerSecond } from "./settings.js";

const TargetBodySchema = z.object({ playerId: z.string().uuid() });

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

  /**
   * Pay a local inmate out. Money moves from the CALLER; the inmate's
   * balance is never touched. Mirrors `POST /api/hospital/discharge-player`.
   */
  app.post("/api/jail/bail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TargetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const targetId = parsed.data.playerId;
    if (targetId === playerId) return reply.code(409).send({ error: "self_target" });

    try {
      const result = await db.transaction(async (tx) => {
        // ONE sorted call over both players, FIRST statement, before either row
        // is read (CLAUDE.md rule 6) — the same shape as discharge-player.
        await lockPlayersForUpdate(tx, [playerId, targetId]);

        const [caller] = await tx.select({ locationId: playerStats.locationId })
          .from(playerStats).where(eq(playerStats.playerId, playerId));
        const [target] = await tx.select({
          locationId: playerStats.locationId,
          jailedUntil: playerStats.jailedUntil,
          username: players.username,
        })
          .from(playerStats)
          .innerJoin(players, eq(players.id, playerStats.playerId))
          .where(eq(playerStats.playerId, targetId));

        if (!target) return { kind: "missing" as const };
        if (target.locationId === null || target.locationId !== caller?.locationId) {
          return { kind: "elsewhere" as const };
        }

        const remainingMs = (target.jailedUntil?.getTime() ?? 0) - Date.now();
        if (remainingMs <= 0) return { kind: "free" as const };
        const remainingSeconds = Math.ceil(remainingMs / 1000);

        const cost = BigInt(remainingSeconds) * bailCostPerSecond(settings);
        const cash = await applyBalanceChange(tx, {
          playerId, amount: -cost, kind: "cash", reason: "jail.bail",
        });

        await tx.update(playerStats)
          .set({ jailedUntil: null })
          .where(eq(playerStats.playerId, targetId));

        const [me] = await tx.select({ username: players.username })
          .from(players).where(eq(players.id, playerId));

        const notificationId = uuidv7();
        await insertNotification(tx, {
          id: notificationId, playerId: targetId,
          body: `${me?.username ?? "Someone"} paid your bail.`,
        });

        return {
          kind: "paid" as const, cash, cost, notificationId,
          targetName: target.username,
        };
      });

      if (result.kind === "missing") return reply.code(404).send({ error: "player_not_found" });
      if (result.kind === "elsewhere") return reply.code(409).send({ error: "wrong_location" });
      if (result.kind === "free") return reply.code(409).send({ error: "not_jailed" });

      // After commit, never inside the transaction (CLAUDE.md rule 5). Both
      // events are addressed to the TARGET and carry the target as actor.
      const at = new Date().toISOString();
      await publishEvent(redis, {
        id: uuidv7(), type: "player.released", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
      });
      await publishEvent(redis, {
        id: uuidv7(), type: "notification.created", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
        notificationId: result.notificationId,
        body: "Someone paid your bail.",
      });

      return reply.send({
        freed: targetId,
        paid: result.cost.toString(),
        cash: result.cash.toString(),
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reply.code(409).send({ error: "insufficient_funds" });
      }
      throw error;
    }
  });
}
