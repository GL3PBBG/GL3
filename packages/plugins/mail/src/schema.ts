import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Mirrors of core-owned tables — this plugin reads/writes `mail_messages` and
 * reads `players` (recipient lookup by username), but owns neither schema.
 * Column names and types match `apps/server/src/db/schema/social.ts` and
 * `identity.ts` exactly, which is what lets `tx.db.select` / `.insert` /
 * `.update` type and serialise correctly. Neither is listed in this plugin's
 * manifest `tables` map and neither gets a migration here: core already owns
 * and migrates both (the pattern `packages/plugins/news/src/schema.ts`
 * established — the loader enforces naming and prefix rules only on tables a
 * manifest *declares*).
 *
 * Only the columns this plugin touches are listed. `mail_messages` has two
 * indexes (`mail_recipient_idx`, `mail_thread_idx`); they affect performance,
 * not correctness or types, and stay core-owned.
 */
export const mailMessages = pgTable("mail_messages", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull(),
  senderId: uuid("sender_id"),
  recipientId: uuid("recipient_id").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});
