import { and, desc, eq, or } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { IdSchema, SendMailRequestSchema, type GameEvent } from "@gl3/shared";
import { z } from "zod";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { mailMessages, players } from "../../db/schema/index.js";

const MailParamsSchema = z.object({ mailId: IdSchema });
const ThreadParamsSchema = z.object({ threadId: IdSchema });

function toDto(row: typeof mailMessages.$inferSelect, senderName: string | null): Record<string, unknown> {
  return {
    id: row.id, threadId: row.threadId, senderId: row.senderId, senderName,
    recipientId: row.recipientId, subject: row.subject, body: row.body,
    readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

export function registerMailRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post("/api/mail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = SendMailRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    const [recipient] = await db.select({ id: players.id }).from(players).where(eq(players.username, parsed.data.recipientUsername));
    if (!recipient) return reply.code(404).send({ error: "recipient_not_found" });

    let threadId = parsed.data.threadId;
    if (threadId) {
      const [existing] = await db.select({ senderId: mailMessages.senderId, recipientId: mailMessages.recipientId })
        .from(mailMessages)
        .where(and(eq(mailMessages.threadId, threadId), or(eq(mailMessages.senderId, playerId), eq(mailMessages.recipientId, playerId))));
      if (!existing) return reply.code(403).send({ error: "forbidden" });

      // The brief's sample only verified the *sender* was already a
      // participant of the thread, not that the addressed recipient was
      // too. That let any real participant splice an unrelated third party
      // into someone else's private thread by reusing its threadId — e.g.
      // Vito continuing his thread with Sonny but addressing the reply to
      // Clemenza, who never sent or received anything in it. Requiring the
      // resolved recipient to also be a participant closes that.
      const isRecipientParticipant = existing.senderId === recipient.id || existing.recipientId === recipient.id;
      if (!isRecipientParticipant) return reply.code(403).send({ error: "forbidden" });
    } else {
      threadId = uuidv7();
    }

    const id = uuidv7();
    await db.insert(mailMessages).values({
      id, threadId, senderId: playerId, recipientId: recipient.id,
      subject: parsed.data.subject, body: parsed.data.body,
    });

    const [sender] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
    const event: GameEvent = {
      id: uuidv7(), type: "mail.received", at: new Date().toISOString(),
      actorId: playerId, actorName: sender?.username ?? "unknown", audience: { kind: "player", playerId: recipient.id },
      mailId: id, recipientId: recipient.id, subject: parsed.data.subject,
    };
    await publishEvent(redis, event);

    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, id));
    return reply.code(201).send(toDto(row!, sender?.username ?? null));
  });

  app.get("/api/mail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await db.select().from(mailMessages).where(eq(mailMessages.recipientId, playerId)).orderBy(desc(mailMessages.createdAt));
    const senderIds = [...new Set(rows.map((r) => r.senderId).filter((id): id is string => id !== null))];
    const senders = senderIds.length > 0
      ? await db.select({ id: players.id, username: players.username }).from(players).where(or(...senderIds.map((id) => eq(players.id, id))))
      : [];
    const nameById = new Map(senders.map((s) => [s.id, s.username]));

    return reply.send({ mail: rows.map((r) => toDto(r, r.senderId ? nameById.get(r.senderId) ?? null : null)) });
  });

  app.get("/api/mail/thread/:threadId", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const rows = await db.select().from(mailMessages)
      .where(and(
        eq(mailMessages.threadId, params.data.threadId),
        or(eq(mailMessages.senderId, playerId), eq(mailMessages.recipientId, playerId)),
      ))
      .orderBy(mailMessages.createdAt);

    // The brief's sample hardcoded senderName to null here — dropped for no
    // reason, and inconsistent with the inbox handler above, which resolves
    // it. Resolve it the same way so both endpoints return the same DTO
    // shape with real data.
    const senderIds = [...new Set(rows.map((r) => r.senderId).filter((id): id is string => id !== null))];
    const senders = senderIds.length > 0
      ? await db.select({ id: players.id, username: players.username }).from(players).where(or(...senderIds.map((id) => eq(players.id, id))))
      : [];
    const nameById = new Map(senders.map((s) => [s.id, s.username]));

    return reply.send({ mail: rows.map((r) => toDto(r, r.senderId ? nameById.get(r.senderId) ?? null : null)) });
  });

  app.post("/api/mail/:mailId/read", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });
    const params = MailParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const [updated] = await db.update(mailMessages)
      .set({ readAt: new Date() })
      .where(and(eq(mailMessages.id, params.data.mailId), eq(mailMessages.recipientId, playerId)))
      .returning({ id: mailMessages.id });

    if (!updated) return reply.code(404).send({ error: "mail_not_found" });
    return reply.code(204).send();
  });
}
