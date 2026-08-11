import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { players } from "./identity.js";
import { items, locations } from "./content.js";

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

export const bounties = pgTable("bounties", {
  id: uuid("id").primaryKey(),
  placedBy: uuid("placed_by").notNull().references(() => players.id, { onDelete: "cascade" }),
  target: uuid("target").notNull().references(() => players.id, { onDelete: "cascade" }),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedBy: uuid("claimed_by").references(() => players.id, { onDelete: "set null" }),
}, (t) => ({ targetIdx: index("bounties_target_idx").on(t.target) }));

export const detectiveSearches = pgTable("detective_searches", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  targetPlayerId: uuid("target_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  detectives: integer("detectives").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  succeeded: boolean("succeeded"),
});

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

/**
 * One row per SHOT, not per kill — `fatal` marks the last one. Misses are
 * logged too: "someone shot at me and missed" is information the bounty and
 * detective clusters will both want, and it is where death attribution lives
 * now that V2's `US_shotBy` is gone (spec §2.5 dropped it).
 *
 * NO `location_id`, deliberately. These FKs are taken while the transaction
 * holds two `player_stats` rows FOR UPDATE; a `locations` FK would take
 * FOR KEY SHARE on a location row at that point — player-then-location,
 * the inverse of the location-first order `travel` and `bullets` follow, which
 * closes an ABBA cycle (CLAUDE.md rule 6). The location is recoverable from
 * context and is not worth an inverted lock order.
 */
export const combatLog = pgTable("combat_log", {
  id: uuid("id").primaryKey(),
  attackerId: uuid("attacker_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  targetId: uuid("target_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  hit: boolean("hit").notNull(),
  damage: integer("damage").notNull().default(0),
  fatal: boolean("fatal").notNull().default(false),
  weaponItemId: uuid("weapon_item_id").references(() => items.id, { onDelete: "set null" }),
  /** Cash taken from the victim. Non-zero only on a fatal row. */
  payout: bigint("payout", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  targetIdx: index("combat_log_target_idx").on(t.targetId, t.createdAt),
  attackerIdx: index("combat_log_attacker_idx").on(t.attackerId, t.createdAt),
}));
