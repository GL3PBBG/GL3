import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/bullets/src/schema.ts` established. Column names and
 * types match `apps/server/src/db/schema/*.ts` exactly, which is what lets
 * `tx.db.select` / `tx.db.update` type and serialise correctly. None is
 * declared in this plugin's manifest `tables` map and none gets a migration
 * here: core already owns and migrates all six, `combat_log` included (it
 * ships in migration `0005`).
 *
 * Only the columns this plugin touches are listed. `player_stats` has ~9 more.
 *
 * `players.username` is `citext` in core; every existing plugin mirror types
 * it `text`, which is what drizzle needs to serialise it and what the wire
 * sees either way.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
  exp: bigint("exp", { mode: "bigint" }).notNull(),
  bullets: bigint("bullets", { mode: "bigint" }).notNull(),
  health: integer("health").notNull(),
  rankId: uuid("rank_id"),
  gangId: uuid("gang_id"),
  locationId: uuid("location_id"),
  weaponItemId: uuid("weapon_item_id"),
  armorItemId: uuid("armor_item_id"),
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
  hospitalUntil: timestamp("hospital_until", { withTimezone: true }),
});

export const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  itemType: text("item_type").notNull(),
  effects: jsonb("effects").notNull(),
});

export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  maxHealth: integer("max_health").notNull(),
});

export const gangMembers = pgTable("gang_members", {
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id").notNull(),
});

export const combatLog = pgTable("combat_log", {
  id: uuid("id").primaryKey(),
  attackerId: uuid("attacker_id").notNull(),
  targetId: uuid("target_id").notNull(),
  hit: boolean("hit").notNull(),
  damage: integer("damage").notNull(),
  fatal: boolean("fatal").notNull(),
  weaponItemId: uuid("weapon_item_id"),
  payout: bigint("payout", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
