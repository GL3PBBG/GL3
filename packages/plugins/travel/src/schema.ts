import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of two core-owned tables, same pattern as
 * `packages/plugins/bullets/src/schema.ts`: column names and types match
 * `apps/server/src/db/schema/identity.ts` and `content.ts` exactly, neither
 * table is declared in this plugin's manifest, and neither gets a migration
 * here — core already owns and migrates both.
 *
 * `bullet_stock` and `bullet_cost` are listed because `GET /api/locations`
 * returns them (core's `game/travel/routes.ts` did), not because this plugin
 * writes them. It never does; `bullets` owns those columns.
 *
 * `combat_mode` is listed because travel both reads it (the board) and writes
 * it (admin create/update) — the one column on this mirror this plugin owns
 * end to end, though the table itself still belongs to core.
 */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  travelCost: bigint("travel_cost", { mode: "bigint" }).notNull(),
  travelCooldownSeconds: integer("travel_cooldown_seconds").notNull(),
  bulletStock: integer("bullet_stock").notNull(),
  bulletCost: bigint("bullet_cost", { mode: "bigint" }).notNull(),
  combatMode: text("combat_mode").notNull(),
});
