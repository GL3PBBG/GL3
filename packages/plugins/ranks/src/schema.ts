import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Read-only mirrors of two core-owned tables. Column names and types match
 * `apps/server/src/db/schema/identity.ts` exactly, which is what lets
 * `tx.db.select` type and serialise correctly — but neither table is listed
 * in this plugin's manifest `tables` map and neither gets a migration here:
 * core already owns and migrates both (confirmed against
 * `apps/server/src/plugins/loader.ts` — a manifest with no `tables` entry
 * for a name can still `select` from it, since the loader only enforces
 * naming/prefix rules on tables the manifest *declares*).
 */
export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  expRequired: bigint("exp_required", { mode: "bigint" }).notNull(),
  cashReward: bigint("cash_reward", { mode: "bigint" }).notNull(),
  bulletReward: integer("bullet_reward").notNull(),
  maxHealth: integer("max_health").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  rankId: uuid("rank_id"),
});
