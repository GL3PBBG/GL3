import { bigint, boolean, index, integer, pgTable, text, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";
import { balanceKind } from "./enums.js";
import { players } from "./identity.js";
import { cars, crimes, items, locations } from "./content.js";

/** Append-only. Never updated, never deleted. sum(amount) per kind == balance. */
export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  balanceKind: balanceKind("balance_kind").notNull(),
  reason: text("reason").notNull(),
  refId: uuid("ref_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  playerIdx: index("transactions_player_idx").on(t.playerId),
  playerKindIdx: index("transactions_player_kind_idx").on(t.playerId, t.balanceKind),
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
  cost: bigint("cost", { mode: "bigint" }).notNull().default(0n),
  profit: bigint("profit", { mode: "bigint" }).notNull().default(0n),
}, (t) => ({ locationIdx: index("properties_location_idx").on(t.locationId) }));

export const crimeLog = pgTable("crime_log", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  crimeId: uuid("crime_id").notNull().references(() => crimes.id, { onDelete: "cascade" }),
  success: boolean("success").notNull(),
  payout: bigint("payout", { mode: "bigint" }).notNull().default(0n),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ playerIdx: index("crime_log_player_idx").on(t.playerId, t.createdAt) }));
