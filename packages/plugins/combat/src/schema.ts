import { sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/bullets/src/schema.ts` established. Column names and
 * types match `apps/server/src/db/schema/*.ts` exactly, which is what lets
 * `tx.db.select` / `tx.db.update` type and serialise correctly. Core owns and
 * migrates `players`, `player_stats`, `items` and `ranks`.
 *
 * `p_combat_log` is the exception and is NOT a mirror: this plugin owns and
 * migrates it (`migrations.ts`). It was core-owned — it shipped in core
 * migration `0005` — until core relinquished it in
 * `0007_relinquish_plugin_tables`.
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
  /** Per-player cap override (core migration 0017); NULL = the rank's cap. */
  healthMax: integer("health_max"),
  // The melee leg's resolution inputs (C6): MCCodes damage is
  // power × strength ÷ (guard / 1.5), hit chance the agility ratio.
  strength: bigint("strength", { mode: "bigint" }).notNull(),
  agility: bigint("agility", { mode: "bigint" }).notNull(),
  guard: bigint("guard", { mode: "bigint" }).notNull(),
  energy: integer("energy").notNull(),
  energyMax: integer("energy_max").notNull(),
  energyRegenAt: timestamp("energy_regen_at", { withTimezone: true }),
  rankId: uuid("rank_id"),
  gangId: uuid("gang_id"),
  locationId: uuid("location_id"),
  weaponItemId: uuid("weapon_item_id"),
  // The melee-only second weapon slot (B0, migration 0019): fires only when
  // the firearm slot above is empty, and only if the row is a melee model.
  weaponMeleeItemId: uuid("weapon_melee_item_id"),
  armorItemId: uuid("armor_item_id"),
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
  hospitalUntil: timestamp("hospital_until", { withTimezone: true }),
  backfire: integer("backfire").notNull(),
});

export const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  itemType: text("item_type").notNull(),
  effects: jsonb("effects").notNull(),
  name: text("name").notNull(),
});

export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  maxHealth: integer("max_health").notNull(),
});

/**
 * The four defaults are not decoration: drizzle makes a `notNull` column with
 * no default REQUIRED on insert, so without them `createdAt` would have to be
 * passed by hand on every write — a clock read in application code where
 * Postgres' `now()` is both correct and already the column default. They match
 * the DDL in `migrations.ts`, which is now the definition rather than a copy
 * of core's.
 */
export const combatLog = pgTable("p_combat_log", {
  id: uuid("id").primaryKey(),
  attackerId: uuid("attacker_id").notNull(),
  targetId: uuid("target_id").notNull(),
  hit: boolean("hit").notNull(),
  damage: integer("damage").notNull().default(0),
  fatal: boolean("fatal").notNull().default(false),
  weaponItemId: uuid("weapon_item_id"),
  // `sql\`0\``, never `0n` — drizzle-kit's serialiser crashes on BigInt.
  payout: bigint("payout", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Owned and migrated by this plugin (`migrations.ts` `0004`), not a mirror.
 * Grain is `(player, item)`, matching core `player_items` — which is qty-
 * stacked with no per-instance identity, so a player owning two of the same
 * pistol has ONE shared condition. Buying another copy does not improve it;
 * you cannot dilute wear.
 */
export const weaponCondition = pgTable("p_combat_weapon_condition", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  condition: integer("condition").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.itemId] }) }));

/**
 * Core-owned mirror. Read-only here, and only to answer "does the caller own
 * this weapon" for the repair route — a weapon need not be equipped to be
 * repaired.
 */
export const playerItems = pgTable("player_items", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  qty: integer("qty").notNull(),
});

/** Core-owned; only the mode column combat reads. */
export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  combatMode: text("combat_mode").notNull(),
});
