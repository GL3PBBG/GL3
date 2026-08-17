import { sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** The table this plugin OWNS. `migrations.ts` is the definition; this handle
 *  must be kept in step with it by hand. */
export const casinoSessions = pgTable("p_casino_sessions", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  gameId: text("game_id").notNull(),
  locationId: uuid("location_id").notNull(),
  propertyId: uuid("property_id"),
  wager: bigint("wager", { mode: "bigint" }).notNull().default(sql`0`),
  state: jsonb("state").notNull(),
  status: text("status").notNull(),
  seed: text("seed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

/** Read-only mirrors of core-owned tables — the pattern
 *  `packages/plugins/theft/src/schema.ts` established. No FKs on mirrors. */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  locationId: uuid("location_id"),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});
