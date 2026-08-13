import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { players } from "./identity.js";
import { locations } from "./content.js";

export const gangs = pgTable("gangs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  info: text("info").notNull().default(""),
  /** V2 kept two balances (G_bank and G_money); both preserved. */
  bank: bigint("bank", { mode: "bigint" }).notNull().default(sql`0`),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(sql`0`),
  bullets: bigint("bullets", { mode: "bigint" }).notNull().default(sql`0`),
  level: integer("level").notNull().default(1),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  bossPlayerId: uuid("boss_player_id").references((): AnyPgColumn => players.id, { onDelete: "set null" }),
  underbossPlayerId: uuid("underboss_player_id").references((): AnyPgColumn => players.id, { onDelete: "set null" }),
});

/** Replaces V2's US_gang integer column. */
export const gangMembers = pgTable("gang_members", {
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.gangId, t.playerId] }),
  playerIdx: index("gang_members_player_idx").on(t.playerId),
}));

export const gangPermissions = pgTable("gang_permissions", {
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.gangId, t.playerId, t.permission] }) }));

export const gangInvites = pgTable("gang_invites", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  invitedPlayerId: uuid("invited_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  invitedByPlayerId: uuid("invited_by_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ invitedIdx: index("gang_invites_invited_idx").on(t.invitedPlayerId) }));

/** Append-only gang audit log. */
export const gangLogs = pgTable("gang_logs", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ gangIdx: index("gang_logs_gang_idx").on(t.gangId, t.createdAt) }));

/**
 * `bounties`, `detective_searches` and `combat_log` used to live here. They are
 * gone from core, not from the game: each is now owned and migrated by the one
 * plugin that ever touched it — `p_bounties_bounties`, `p_detectives_searches`
 * and `p_combat_log` respectively. They were core-owned only because
 * `0000_core_schema` (and, for combat, `0005_combat_log`) predated the plugin
 * migration runner, and core code never read or wrote any of the three.
 * Core relinquishes them in `0007_relinquish_plugin_tables`.
 */

/** V2 threaded PMs via M_parent → thread_id (spec §2.5). */
export const mailMessages = pgTable("mail_messages", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull(),
  senderId: uuid("sender_id").references(() => players.id, { onDelete: "set null" }),
  recipientId: uuid("recipient_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  recipientIdx: index("mail_recipient_idx").on(t.recipientId, t.createdAt),
  threadIdx: index("mail_thread_idx").on(t.threadId),
}));

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ playerIdx: index("notifications_player_idx").on(t.playerId, t.createdAt) }));

export const gameNews = pgTable("game_news", {
  id: uuid("id").primaryKey(),
  authorId: uuid("author_id").references(() => players.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

