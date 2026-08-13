import { bigint, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/bullets/src/schema.ts` established. Column names and
 * types match `apps/server/src/db/schema/*.ts` exactly. None is declared in
 * this plugin's manifest `tables` map and none gets a migration here: core
 * already owns and migrates all of them.
 *
 * Only the columns this plugin touches are listed.
 */
export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  itemType: text("item_type").notNull(),
  effects: jsonb("effects").notNull(),
});

export const playerItems = pgTable("player_items", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  qty: integer("qty").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  exp: bigint("exp", { mode: "bigint" }).notNull(),
  health: integer("health").notNull(),
  rankId: uuid("rank_id"),
  locationId: uuid("location_id"),
  weaponItemId: uuid("weapon_item_id"),
  armorItemId: uuid("armor_item_id"),
});

export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  maxHealth: integer("max_health").notNull(),
});
