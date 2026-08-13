import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/combat/src/schema.ts` documents. Core owns and migrates
 * `players`, `player_stats` and `ranks`; only touched columns are listed.
 *
 * `p_bounties_bounties` is the exception and is NOT a mirror: this plugin owns
 * and migrates it (`migrations.ts`). It was core-owned until core relinquished
 * it in `0007_relinquish_plugin_tables`.
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

export const bounties = pgTable("p_bounties_bounties", {
  id: uuid("id").primaryKey(),
  placedBy: uuid("placed_by").notNull(),
  target: uuid("target").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedBy: uuid("claimed_by"),
});
