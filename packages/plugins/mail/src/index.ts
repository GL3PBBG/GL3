import { definePlugin, newId, PluginError, route } from "@gl3/plugin-sdk";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { mailMessages, players } from "./schema.js";

/**
 * Ported verbatim from `apps/server/src/game/mail/routes.ts`: paths, status
 * codes, error strings, response bodies and the `mail.received` event are
 * byte-identical. `apps/server/test/mail.test.ts` is unchanged and is the
 * proof (all `app.inject`, written against core).
 *
 * Four deliberate differences (design §3.1, §3.5, §5, plus the batch-lookup form below):
 *  - `POST`'s re-`select` after insert becomes `.insert(...).returning()` —
 *    same row, one fewer round trip (design §3.5).
 *  - A 400 from a bad body carries `{ error: "invalid_request" }` with no
 *    `issues` array, because the plugin route layer owns body validation
 *    (`apps/server/src/plugins/routes.ts`). Nothing in `@gl3/web` reads
 *    `issues`. Identical to what `news` documented (design §5).
 *  - `actorName` comes from `ctx.player.username` — no `players` read for the
 *    sender, where core did one at routes.ts:62 (design §3.1).
 *  - Batch sender-name lookups use `inArray` instead of core's
 *    `or(...senderIds.map((id) => eq(players.id, id)))` — single `= ANY(...)`
 *    vs a nested OR chain, same result. `news` already used this form.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema` and
 * `noNulByte` are restated below. The NUL guard is load-bearing: Postgres
 * `text` rejects an embedded NUL outright (SQLSTATE 22021), and
 * `recipientUsername` reaches Postgres as an `eq(players.username, ...)`
 * lookup parameter — so without it, three of mail.test.ts's cases 500 instead
 * of 400.
 */
const noNulByte = <T extends z.ZodString>(schema: T): z.ZodEffects<T, string, string> =>
  schema.refine((value) => !value.includes("\u0000"), { message: "must not contain a NUL byte" });

const IdSchema = z.string().uuid();

const SendMailBodySchema = z.object({
  recipientUsername: noNulByte(z.string().min(3).max(30)),
  subject: noNulByte(z.string().min(1).max(200)),
  body: noNulByte(z.string().min(1).max(5000)),
  /** Reply within an existing thread; omit to start a new one. */
  threadId: IdSchema.optional(),
});

const MailParamsSchema = z.object({ mailId: IdSchema });
const ThreadParamsSchema = z.object({ threadId: IdSchema });

function toDto(
  row: typeof mailMessages.$inferSelect,
  senderName: string | null,
): Record<string, unknown> {
  return {
    id: row.id, threadId: row.threadId, senderId: row.senderId, senderName,
    recipientId: row.recipientId, subject: row.subject, body: row.body,
    readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

const sendRoute = route({
  method: "POST",
  path: "/api/mail",
  body: SendMailBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // (2) Resolve the recipient by username. Unlocked read — no row to lock.
      const [recipient] = await tx.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.username, body.recipientUsername));
      if (!recipient) throw new PluginError("recipient_not_found", 404);

      // (3) Thread participation gate. If a threadId is supplied, the sender
      // must already be a participant AND the resolved recipient must be too.
      // The recipient-side check (routes.ts:50-51) closed a real splice defect
      // — its test ("403s replying in a real thread to a recipient who isn't
      // part of it") must keep passing.
      let threadId = body.threadId;
      if (threadId) {
        const [existing] = await tx.db
          .select({ senderId: mailMessages.senderId, recipientId: mailMessages.recipientId })
          .from(mailMessages)
          .where(and(
            eq(mailMessages.threadId, threadId),
            or(eq(mailMessages.senderId, player.id), eq(mailMessages.recipientId, player.id)),
          ));
        if (!existing) throw new PluginError("forbidden", 403);
        const isRecipientParticipant =
          existing.senderId === recipient.id || existing.recipientId === recipient.id;
        if (!isRecipientParticipant) throw new PluginError("forbidden", 403);
      } else {
        // (4) Fresh thread for a new conversation.
        threadId = newId();
      }

      // (5) Insert the message.
      const id = newId();
      const [inserted] = await tx.db
        .insert(mailMessages)
        .values({
          id, threadId, senderId: player.id, recipientId: recipient.id,
          subject: body.subject, body: body.body,
        })
        .returning();

      // (6) Buffered here, published after commit — events are facts, not
      // commands (NOTES.md rule 5). `mail.received`'s actor is the sender
      // (packages/shared/src/events.ts:48); audience is the recipient.
      await tx.events.publishCore({
        type: "mail.received",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: recipient.id },
        mailId: id,
        recipientId: recipient.id,
        subject: body.subject,
      });

      // (7) `.returning()` replaces core's post-insert re-select (routes.ts:70).
      return { status: 201, body: toDto(inserted!, player.username) };
    });
  },
});

const inboxRoute = route({
  method: "GET",
  path: "/api/mail",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select()
        .from(mailMessages)
        .where(eq(mailMessages.recipientId, player.id))
        .orderBy(desc(mailMessages.createdAt));
      const senderIds = [...new Set(rows.map((r) => r.senderId).filter((id): id is string => id !== null))];
      const senders = senderIds.length > 0
        ? await tx.db
            .select({ id: players.id, username: players.username })
            .from(players)
            .where(inArray(players.id, senderIds))
        : [];
      const nameById = new Map(senders.map((s) => [s.id, s.username]));
      return {
        status: 200,
        body: { mail: rows.map((r) => toDto(r, r.senderId ? nameById.get(r.senderId) ?? null : null)) },
      };
    });
  },
});

const threadRoute = route({
  method: "GET",
  path: "/api/mail/thread/:threadId",
  params: ThreadParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { threadId } = params;

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select()
        .from(mailMessages)
        .where(and(
          eq(mailMessages.threadId, threadId),
          or(eq(mailMessages.senderId, player.id), eq(mailMessages.recipientId, player.id)),
        ))
        .orderBy(mailMessages.createdAt);
      // Sender-name resolution is not optional: the thread view's
      // senderName==="Vito" assertion (mail.test.ts:247) was the defect the
      // brief's sample introduced by hardcoding null. Resolve it the same way
      // the inbox does.
      const senderIds = [...new Set(rows.map((r) => r.senderId).filter((id): id is string => id !== null))];
      const senders = senderIds.length > 0
        ? await tx.db
            .select({ id: players.id, username: players.username })
            .from(players)
            .where(inArray(players.id, senderIds))
        : [];
      const nameById = new Map(senders.map((s) => [s.id, s.username]));
      return {
        status: 200,
        body: { mail: rows.map((r) => toDto(r, r.senderId ? nameById.get(r.senderId) ?? null : null)) },
      };
    });
  },
});

const markReadRoute = route({
  method: "POST",
  path: "/api/mail/:mailId/read",
  params: MailParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { mailId } = params;

    return ctx.transaction(async (tx) => {
      // recipientId = player is the access control: marking someone else's
      // mail read affects zero rows and returns 404, not 200.
      const [updated] = await tx.db
        .update(mailMessages)
        .set({ readAt: new Date() })
        .where(and(eq(mailMessages.id, mailId), eq(mailMessages.recipientId, player.id)))
        .returning({ id: mailMessages.id });
      if (!updated) throw new PluginError("mail_not_found", 404);
      return { status: 204, body: null };
    });
  },
});

export default definePlugin({
  id: "mail",
  version: "1.0.0",
  basePaths: ["/api/mail"],
  routes: [sendRoute, inboxRoute, threadRoute, markReadRoute],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot
  // if a core plugin declares any.
});
