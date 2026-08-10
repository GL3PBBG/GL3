import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Mirrors of core-owned tables — this plugin reads and writes `game_news` and
 * reads the two role tables, but owns none of their schemas. Column names and
 * types match `apps/server/src/db/schema/social.ts` and `identity.ts` exactly,
 * which is what lets `tx.db.select` / `tx.db.insert` type and serialise
 * correctly. None is listed in this plugin's manifest `tables` map and none
 * gets a migration here: core already owns and migrates all three (same
 * pattern and reasoning as `packages/plugins/ranks/src/schema.ts`).
 */
export const gameNews = pgTable("game_news", {
  id: uuid("id").primaryKey(),
  authorId: uuid("author_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
  roleId: uuid("role_id"),
});

export const roleModuleAccess = pgTable("role_module_access", {
  roleId: uuid("role_id").notNull(),
  moduleKey: text("module_key").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.moduleKey] }) }));
