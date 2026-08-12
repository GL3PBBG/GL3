import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uuid, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { balanceKind } from "./enums.js";
import { players } from "./identity.js";
import { gangs } from "./social.js";
import { cars, crimes, items, locations } from "./content.js";

/**
 * Append-only. Never updated, never deleted. sum(amount) per owner == that
 * owner's balance. An owner is either a player OR a gang (spec §1.2: gangs
 * carry two balances, G_bank/G_money, preserved here as gangs.bank/cash) —
 * exactly one of player_id/gang_id is set per row, enforced below.
 */
export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").references(() => players.id, { onDelete: "cascade" }),
  gangId: uuid("gang_id").references(() => gangs.id, { onDelete: "cascade" }),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  balanceKind: balanceKind("balance_kind").notNull(),
  reason: text("reason").notNull(),
  refId: uuid("ref_id"),
  /** Unused by this milestone's own routes (gang bank is synchronous — see plan Decision 2); kept for the next economy-mutating worker, mirroring crime_log.job_id. */
  jobId: text("job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  playerIdx: index("transactions_player_idx").on(t.playerId),
  playerKindIdx: index("transactions_player_kind_idx").on(t.playerId, t.balanceKind),
  gangIdx: index("transactions_gang_idx").on(t.gangId),
  gangKindIdx: index("transactions_gang_kind_idx").on(t.gangId, t.balanceKind),
  jobIdUnique: uniqueIndex("transactions_job_id_unique").on(t.jobId),
  ownerXor: check("transactions_owner_xor", sql`(${t.playerId} IS NOT NULL) <> (${t.gangId} IS NOT NULL)`),
}));

export const playerItems = pgTable("player_items", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.itemId] }) }));

/** Cars are location-bound in V2 (spec §1.2 garage). */
export const garage = pgTable("garage", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  carId: uuid("car_id").notNull().references(() => cars.id, { onDelete: "cascade" }),
  damage: integer("damage").notNull().default(0),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
}, (t) => ({ playerIdx: index("garage_player_idx").on(t.playerId) }));

/** V2 PR_module is a string naming the implementing module → plugin_id (spec §1.2). */
export const properties = pgTable("properties", {
  id: uuid("id").primaryKey(),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id").notNull(),
  ownerPlayerId: uuid("owner_player_id").references(() => players.id, { onDelete: "set null" }),
  cost: bigint("cost", { mode: "bigint" }).notNull().default(sql`0`),
  profit: bigint("profit", { mode: "bigint" }).notNull().default(sql`0`),
}, (t) => ({ locationIdx: index("properties_location_idx").on(t.locationId) }));

export const crimeLog = pgTable("crime_log", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  crimeId: uuid("crime_id").notNull().references(() => crimes.id, { onDelete: "cascade" }),
  success: boolean("success").notNull(),
  payout: bigint("payout", { mode: "bigint" }).notNull().default(sql`0`),
  /**
   * BullMQ job id — a trace column, NOT an idempotency guard. It was unique
   * while the deleted core worker keyed its replay check on it; the crimes
   * plugin's guard is `plugin_job_runs` (structural in ctx.transaction), and
   * the plugin's queue (`crimes-commit`) numbers jobs from 1 independently of
   * the retired core queue (`bull:crime`), so a live DB's core-era rows
   * collide with plugin-era ids. Migration 0006 dropped the unique index for
   * exactly that reason — the first plugin-era commit on a live game failed
   * all three attempts against core-era job 1.
   */
  jobId: text("job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  playerIdx: index("crime_log_player_idx").on(t.playerId, t.createdAt),
}));
