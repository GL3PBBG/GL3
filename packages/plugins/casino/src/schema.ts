import { sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

/** The second table this plugin OWNS, kept in step with `migrations.ts` by
 *  hand, same as `casinoSessions` above. */
export const casinoTables = pgTable("p_casino_tables", {
  id: uuid("id").primaryKey(),
  gameId: text("game_id").notNull(),
  locationId: uuid("location_id").notNull(),
  propertyId: uuid("property_id"),
  phase: text("phase").notNull().default("betting"),
  turnSeat: smallint("turn_seat"),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  handNo: integer("hand_no").notNull().default(0),
  state: jsonb("state"),
  seed: text("seed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The third table this plugin OWNS, kept in step with `migrations.ts` by
 *  hand, same as `casinoSessions` above. */
export const casinoSeats = pgTable("p_casino_seats", {
  id: uuid("id").primaryKey(),
  tableId: uuid("table_id").notNull(),
  playerId: uuid("player_id").notNull(),
  seatNo: smallint("seat_no").notNull(),
  wager: bigint("wager", { mode: "bigint" }).notNull().default(sql`0`),
  leaving: boolean("leaving").notNull().default(false),
  idleHands: integer("idle_hands").notNull().default(0),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
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
