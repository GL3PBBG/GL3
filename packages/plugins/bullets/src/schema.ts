import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of two core-owned tables. Column names and types match
 * `apps/server/src/db/schema/identity.ts` and `content.ts` exactly, which is
 * what lets `tx.db.select` / `tx.db.update` type and serialise correctly.
 * Neither is listed in this plugin's manifest `tables` map and neither gets a
 * migration here: core already owns and migrates both (the pattern
 * `packages/plugins/ranks/src/schema.ts` established — the loader enforces
 * naming and prefix rules only on tables a manifest *declares*).
 *
 * Only the columns this plugin touches are listed. `player_stats` has ~15
 * more; naming them here would be a maintenance burden with no consumer.
 */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  bullets: bigint("bullets", { mode: "bigint" }).notNull(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  bulletStock: integer("bullet_stock").notNull(),
  bulletCost: bigint("bullet_cost", { mode: "bigint" }).notNull(),
});
