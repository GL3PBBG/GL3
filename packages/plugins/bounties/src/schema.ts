import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/combat/src/schema.ts` documents. Core owns and migrates
 * all four; `bounties` ships in core migration `0000`
 * (`apps/server/src/db/schema/social.ts:54`). Only touched columns listed.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  gangId: uuid("gang_id"),
  rankId: uuid("rank_id"),
});

export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const bounties = pgTable("bounties", {
  id: uuid("id").primaryKey(),
  placedBy: uuid("placed_by").notNull(),
  target: uuid("target").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedBy: uuid("claimed_by"),
});
