import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read-only mirror of a core-owned table. Column names and types match
 * `apps/server/src/db/schema/social.ts` exactly, which is what lets
 * `tx.db.select` / `tx.db.update` type and serialise correctly — but the
 * table is not listed in this plugin's manifest `tables` map and gets no
 * migration here: core already owns and migrates it (see
 * `packages/plugins/ranks/src/schema.ts` for the same pattern and the
 * reasoning behind it).
 */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
