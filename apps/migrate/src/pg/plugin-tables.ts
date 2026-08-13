import { bigint, boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle handles for the two plugin-owned tables the migrator writes.
 *
 * Core relinquished `bounties` and `detective_searches` in
 * `0007_relinquish_plugin_tables`; the `bounties`/`detectives` plugins own and
 * migrate them as `p_bounties_bounties` / `p_detectives_searches`. The plugin
 * packages export only their manifests, so this is a MIRROR — the same pattern
 * as `apps/server/test/helpers/plugin-tables.ts`: the DDL in each plugin's
 * `migrations.ts` is the definition, and these must be kept in step by hand.
 *
 * Foreign keys are omitted, as in that file: drizzle only needs `references`
 * to generate DDL, and nothing here generates DDL — `createIsolatedPgTarget`
 * runs the plugins' real migrations.
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
