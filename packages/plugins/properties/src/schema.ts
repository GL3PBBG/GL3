import { sql } from "drizzle-orm";
import { bigint, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * The table this plugin OWNS. `migrations.ts` is the definition and this
 * handle must be kept in step with it by hand.
 *
 * `cost` is the OWNER'S LEVER, not a purchase price (V2's PR_cost): the
 * consumer plugin reads it as its local price or limit. Zero means "the owner
 * has set none — consumer, use your own default". The acquisition price lives
 * in the consumer's `providesProperties` declaration.
 *
 * `profit` is lifetime P&L and MAY BE NEGATIVE: a consumer that makes the
 * owner the house (V2's blackjack) debits through `payOwner`.
 */
export const propertiesTable = pgTable("p_properties_properties", {
  id: uuid("id").primaryKey(),
  locationId: uuid("location_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  ownerPlayerId: uuid("owner_player_id"),
  cost: bigint("cost", { mode: "bigint" }).notNull().default(sql`0`),
  profit: bigint("profit", { mode: "bigint" }).notNull().default(sql`0`),
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

/** Core-owned, mirrored for the list route's owner-name join and the
 *  transfer route's same-IP pair check (anti-bot layer 3). */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
  signupIp: text("signup_ip"),
  lastIp: text("last_ip"),
});

/**
 * Core-owned key/value, mirrored so `payOwner` can read the skim knob LIVE
 * inside the transaction (the bullets-restock cursor precedent — a settings
 * row read from the table, not the boot snapshot). Nothing here locks it FOR
 * UPDATE, so it stays out of the lock graph entirely.
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
