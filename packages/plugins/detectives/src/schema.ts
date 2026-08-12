import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/bounties/src/schema.ts` documents. Core owns and migrates
 * all four; `detective_searches` ships in core migration `0000`
 * (`apps/server/src/db/schema/social.ts:63`). Only touched columns listed.
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

export const detectiveSearches = pgTable("detective_searches", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  targetPlayerId: uuid("target_player_id").notNull(),
  detectives: integer("detectives").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  succeeded: boolean("succeeded"),
});
