import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { CreateGangRequestSchema, IdSchema, InvitePlayerRequestSchema, type GameEvent } from "@gl3/shared";
import { z } from "zod";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { gangInvites, gangLogs, gangMembers, gangs, playerStats, players } from "../../db/schema/index.js";
import { lockPlayersForUpdate } from "../../economy/ledger.js";
import { insertNotification } from "../notifications/service.js";
import { appendGangLog } from "./logs.js";
import { hasGangPermission } from "./permissions.js";

export const GangParamsSchema = z.object({ gangId: IdSchema });
const InviteParamsSchema = z.object({ inviteId: IdSchema });

/**
 * Thrown inside the create-gang transaction when the row-locked recheck
 * finds the player already gang-bound. A plain pre-check-then-act SELECT
 * before the transaction let two concurrent POSTs from the same player both
 * pass the check before either committed, producing two gangs and an
 * orphaned one — see CLAUDE.md rule 2. Locking playerStats via
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

  app.post("/api/gangs/:gangId/invites", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const params = GangParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const body = InvitePlayerRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    const { gangId } = params.data;

    if (!(await hasGangPermission(db, gangId, playerId, "invite"))) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const [target] = await db.select({ id: players.id, gangId: playerStats.gangId })
      .from(players).innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .where(eq(players.username, body.data.username));
    if (!target) return reply.code(404).send({ error: "player_not_found" });
    if (target.gangId) return reply.code(409).send({ error: "already_in_a_gang" });

    const inviteId = uuidv7();
    const notificationId = uuidv7();
    const [gang] = await db.select({ name: gangs.name }).from(gangs).where(eq(gangs.id, gangId));

    await db.transaction(async (tx) => {
      await tx.insert(gangInvites).values({ id: inviteId, gangId, invitedPlayerId: target.id, invitedByPlayerId: playerId });
      await insertNotification(tx, {
        id: notificationId, playerId: target.id,
        body: `${gang?.name ?? "A gang"} invited you to join.`,
      });
      await appendGangLog(tx, gangId, playerId, `invited ${body.data.username}`);
    });

    // events.ts documents notification.created as "actor = the notified
    // player" — the invitee, not the inviter — matching every other
    // privately-audienced event (bank.transacted = the account holder,
    // player.jailed = the jailed player). awaitOwnEvent(subscriber, actorId)
    // is the mandated CLAUDE.md rule-4 filter for the shared game:events
    // channel, so getting this wrong silently breaks any caller waiting on
    // the invitee's own id.
    const [invitee] = await db.select({ username: players.username }).from(players).where(eq(players.id, target.id));
    const event: GameEvent = {
      id: uuidv7(), type: "notification.created", at: new Date().toISOString(),
      actorId: target.id, actorName: invitee?.username ?? "unknown", audience: { kind: "player", playerId: target.id },
      notificationId, body: `${gang?.name ?? "A gang"} invited you to join.`,
    };
    await publishEvent(redis, event);

    return reply.code(201).send({ id: inviteId });
  });

  app.post("/api/gangs/invites/:inviteId/accept", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const params = InviteParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.id, params.data.inviteId));
    if (!invite || invite.invitedPlayerId !== playerId) return reply.code(404).send({ error: "invite_not_found" });

    try {
      await db.transaction(async (tx) => {
        // Locks this player's stats row before checking gangId — closes the
        // race where the same player accepts two invites concurrently. Same
        // primitive and same shape as the create-gang check above.
        await lockPlayersForUpdate(tx, [playerId]);
        const [stats] = await tx.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, playerId));
        if (stats?.gangId) throw new AlreadyInGangError(playerId);

        await tx.update(playerStats).set({ gangId: invite.gangId }).where(eq(playerStats.playerId, playerId));
        await tx.insert(gangMembers).values({ gangId: invite.gangId, playerId });
        await tx.delete(gangInvites).where(eq(gangInvites.invitedPlayerId, playerId));
        await appendGangLog(tx, invite.gangId, playerId, "joined the gang");
      });
    } catch (err) {
      if (err instanceof AlreadyInGangError) return reply.code(409).send({ error: "already_in_a_gang" });
      throw err;
    }

    const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
    const event: GameEvent = {
      id: uuidv7(), type: "gang.memberJoined", at: new Date().toISOString(),
      actorId: playerId, actorName: actor?.username ?? "", audience: { kind: "gang", gangId: invite.gangId },
      gangId: invite.gangId,
    };
    await publishEvent(redis, event);

    const dto = await loadGangDto(db, invite.gangId);
    return reply.send(dto);
  });

  app.post("/api/gangs/invites/:inviteId/decline", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const params = InviteParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const [deleted] = await db.delete(gangInvites)
      .where(and(eq(gangInvites.id, params.data.inviteId), eq(gangInvites.invitedPlayerId, playerId)))
      .returning({ id: gangInvites.id });

    if (!deleted) return reply.code(404).send({ error: "invite_not_found" });
    return reply.code(204).send();
  });
}
