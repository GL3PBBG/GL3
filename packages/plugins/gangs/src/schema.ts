import { sql } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Mirrors of core-owned tables. This plugin reads and writes all seven but
 * owns none: column names, types, nullability and defaults match
 * `apps/server/src/db/schema/social.ts` and `identity.ts` exactly, which is
 * what lets `tx.db.select` / `.insert` / `.update` type and serialise
 * correctly. None is listed in this plugin's manifest `tables` map and none
 * gets a migration here — core already owns and migrates all seven (the
 * pattern `packages/plugins/news/src/schema.ts` established; the loader
 * enforces naming and prefix rules only on tables a manifest *declares*).
 *
 * Only the columns this plugin touches are listed. Composite primary keys
 * (`gang_members`, `gang_permissions`), indexes, unique constraints and FK
 * references stay core-owned: drizzle does not need them for
 * select/insert/update/delete to typecheck, and mirroring them would add
 * drift surface for no type benefit. A wrong omission surfaces as a compile
 * error, not a silent bug — a wrong NULLABILITY or a missing DEFAULT does
 * not, which is why both are matched by hand.
 */
export const gangs = pgTable("gangs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  info: text("info").notNull().default(""),
  bank: bigint("bank", { mode: "bigint" }).notNull().default(sql`0`),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(sql`0`),
  level: integer("level").notNull().default(1),
  bossPlayerId: uuid("boss_player_id"),
  underbossPlayerId: uuid("underboss_player_id"),
});

export const gangMembers = pgTable("gang_members", {
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gangPermissions = pgTable("gang_permissions", {
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id").notNull(),
  permission: text("permission").notNull(),
});

export const gangInvites = pgTable("gang_invites", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull(),
  invitedPlayerId: uuid("invited_player_id").notNull(),
  invitedByPlayerId: uuid("invited_by_player_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Read-only here: writes go through `tx.gangLog`, which core owns. */
export const gangLogs = pgTable("gang_logs", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(sql`0`),
  gangId: uuid("gang_id"),
});
