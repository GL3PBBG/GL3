import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * The three tables this plugin OWNS. `migrations.ts` is the definition and
 * these handles must be kept in step with it by hand.
 */
export const cars = pgTable("p_theft_cars", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  value: bigint("value", { mode: "bigint" }).notNull(),
  theftWeight: integer("theft_weight").notNull().default(1),
});

export const theftTiers = pgTable("p_theft_tiers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  successChance: integer("success_chance").notNull(),
  maxDamage: integer("max_damage").notNull(),
  minCarValue: bigint("min_car_value", { mode: "bigint" }).notNull(),
  maxCarValue: bigint("max_car_value", { mode: "bigint" }).notNull(),
});

export const garage = pgTable("p_theft_garage", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  carId: uuid("car_id").notNull(),
  damage: integer("damage").notNull().default(0),
  locationId: uuid("location_id"),
});

/**
 * Read/write mirrors of core-owned tables, the pattern
 * `packages/plugins/inventory/src/schema.ts` established. Only the columns
 * this plugin touches are listed, and none of these gets a migration here.
 *
 * The FKs that `p_theft_garage` really has are NOT declared above: drizzle
 * only needs `references` to generate DDL, and nothing here generates DDL.
 * The real constraints live in migrations.ts, and they are what rule 6's
 * lock graph is reasoned about.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});
