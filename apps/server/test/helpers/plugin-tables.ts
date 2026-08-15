import { sql } from "drizzle-orm";
import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle handles for three plugin-owned tables that server tests need to seed
 * and assert on.
 *
 * These used to come from `../src/db/schema/index.js`, back when core owned
 * `bounties`, `detective_searches` and `combat_log`. Core relinquished all
 * three in `0007_relinquish_plugin_tables`; the plugins that are their only
 * consumers now own and migrate them (`p_bounties_bounties`,
 * `p_detectives_searches`, `p_combat_log`).
 *
 * Declared here rather than imported from the plugin packages because those
 * export only their manifest (`exports: { "." : ... }`), and widening a plugin's
 * public surface just for tests is not worth eight registration sites. The
 * existing precedent is per-file duplication — `oc-ledger.test.ts`,
 * `oc-concurrency.test.ts` and `oc-lock-order.test.ts` each redeclare
 * `p_oc_heists` — so this file is that pattern with the copies collapsed into
 * one place. It is a MIRROR: the DDL in each plugin's `migrations.ts` is the
 * definition, and these must be kept in step with it by hand.
 *
 * Foreign keys are omitted, as in the oc mirrors: drizzle only needs
 * `references` to generate DDL, and nothing here generates DDL. The real
 * constraints live in the plugins' migrations.
 */

/** Mirrors `packages/plugins/bounties/src/migrations.ts` `0001_bounties`. */
export const bounties = pgTable("p_bounties_bounties", {
  id: uuid("id").primaryKey(),
  placedBy: uuid("placed_by").notNull(),
  target: uuid("target").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedBy: uuid("claimed_by"),
});

/** Mirrors `packages/plugins/detectives/src/migrations.ts` `0001_searches`. */
export const detectiveSearches = pgTable("p_detectives_searches", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  targetPlayerId: uuid("target_player_id").notNull(),
  detectives: integer("detectives").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  succeeded: boolean("succeeded"),
});

/** Mirrors `packages/plugins/combat/src/migrations.ts` `0001_combat_log`. */
export const combatLog = pgTable("p_combat_log", {
  id: uuid("id").primaryKey(),
  attackerId: uuid("attacker_id").notNull(),
  targetId: uuid("target_id").notNull(),
  hit: boolean("hit").notNull(),
  damage: integer("damage").notNull().default(0),
  fatal: boolean("fatal").notNull().default(false),
  weaponItemId: uuid("weapon_item_id"),
  // `sql`0``, never `0n` — drizzle-kit's serialiser crashes on BigInt.
  payout: bigint("payout", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Mirrors `packages/plugins/combat/src/migrations.ts` `0004_weapon_condition`. */
export const weaponCondition = pgTable("p_combat_weapon_condition", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  condition: integer("condition").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Mirrors `packages/plugins/properties/src/migrations.ts` `0001_properties`. */
export const propertiesPlugin = pgTable("p_properties_properties", {
  id: uuid("id").primaryKey(),
  locationId: uuid("location_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  ownerPlayerId: uuid("owner_player_id"),
  cost: bigint("cost", { mode: "bigint" }).notNull(),
  profit: bigint("profit", { mode: "bigint" }).notNull(),
  lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
  rate: bigint("rate", { mode: "bigint" }).notNull(),
});

/** Mirrors `packages/plugins/theft/src/migrations.ts` `0001_cars`. */
export const theftCars = pgTable("p_theft_cars", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  value: bigint("value", { mode: "bigint" }).notNull(),
  theftWeight: integer("theft_weight").notNull().default(1),
});

/** Mirrors `packages/plugins/theft/src/migrations.ts` `0002_tiers`. */
export const theftTiers = pgTable("p_theft_tiers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  successChance: integer("success_chance").notNull(),
  maxDamage: integer("max_damage").notNull(),
  minCarValue: bigint("min_car_value", { mode: "bigint" }).notNull(),
  maxCarValue: bigint("max_car_value", { mode: "bigint" }).notNull(),
});

/** Mirrors `packages/plugins/theft/src/migrations.ts` `0003_garage`. */
export const theftGarage = pgTable("p_theft_garage", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  carId: uuid("car_id").notNull(),
  damage: integer("damage").notNull().default(0),
  locationId: uuid("location_id"),
});
