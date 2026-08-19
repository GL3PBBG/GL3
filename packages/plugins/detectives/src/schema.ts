import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/bounties/src/schema.ts` documents. Core owns and migrates
 * `players`, `player_stats` and `locations`; only touched columns are listed.
 *
 * `p_detectives_searches` is the exception and is NOT a mirror: this plugin
 * owns and migrates it (`migrations.ts`). It was core-owned until core
 * relinquished it in `0007_relinquish_plugin_tables`.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

/**
 * Core-owned key/value config. The admin panel reads and writes the TABLE
 * rather than `ctx.settings` — the snapshot is boot-time, so the panel must
 * show what the next boot will read (bullets' options panel set the pattern).
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const detectiveSearches = pgTable("p_detectives_searches", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  targetPlayerId: uuid("target_player_id").notNull(),
  detectives: integer("detectives").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  succeeded: boolean("succeeded"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
