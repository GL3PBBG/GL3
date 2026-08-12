import { bigint, boolean, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Own tables — created by this plugin's migrations (Task 1), NO foreign
 * keys: an FK is a lock (NOTES.md rule 6), and OC must add no implicit
 * FOR KEY SHARE edges against players/player_stats/locations. Same
 * decision `p_inventory_shop_stock` recorded (item-economy design §4.1).
 */
export const ocHeists = pgTable("p_oc_heists", {
  id: uuid("id").primaryKey(),
  leaderId: uuid("leader_id").notNull(),
  locationId: uuid("location_id").notNull(),
  status: text("status").notNull(), // open | executing | done | failed | cancelled
  buyIn: bigint("buy_in", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
});

export const ocMembers = pgTable(
  "p_oc_members",
  {
    heistId: uuid("heist_id").notNull(),
    playerId: uuid("player_id").notNull(),
    role: text("role").notNull(), // mastermind | driver | gunman | hacker
    state: text("state").notNull(), // invited | accepted
    released: boolean("released").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.heistId, t.playerId] })],
);

/**
 * Read-only mirrors of core-owned tables — the pattern
 * `packages/plugins/bounties/src/schema.ts` documents. Core owns and
 * migrates both; only touched columns listed.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  locationId: uuid("location_id"),
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
  hospitalUntil: timestamp("hospital_until", { withTimezone: true }),
});
