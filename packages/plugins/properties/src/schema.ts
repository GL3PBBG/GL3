import { sql } from "drizzle-orm";
import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The table this plugin OWNS. `migrations.ts` is the definition and this
 * handle must be kept in step with it by hand.
 */
export const propertiesTable = pgTable("p_properties_properties", {
  id: uuid("id").primaryKey(),
  locationId: uuid("location_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  ownerPlayerId: uuid("owner_player_id"),
  cost: bigint("cost", { mode: "bigint" }).notNull().default(sql`0`),
  profit: bigint("profit", { mode: "bigint" }).notNull().default(sql`0`),
  lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
  rate: bigint("rate", { mode: "bigint" }).notNull().default(sql`0`),
});

/**
 * Read-only mirrors of core-owned tables, the pattern
 * `packages/plugins/theft/src/schema.ts` established. Only the columns
 * this plugin touches are listed, and none of these gets a migration here.
 *
 * No FK declarations on mirrors; the real constraints live in migrations.ts,
 * and they are what rule 6's lock graph is reasoned about.
 */
export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  locationId: uuid("location_id"),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
});
