import { bigint, boolean, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read mirrors of three core-owned tables (spec §3.1), same pattern as
 * `packages/plugins/bullets/src/schema.ts`: column names and types match
 * `apps/server/src/db/schema/` exactly, none is declared in this plugin's
 * manifest, and none gets a migration here — core owns and migrates all
 * three. `crime_log` is written by the commit job; `crimes` and
 * `player_crime_skill` are read only.
 */
export const crimes = pgTable("crimes", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  cooldownSeconds: integer("cooldown_seconds").notNull(),
  minPayout: bigint("min_payout", { mode: "bigint" }).notNull(),
  maxPayout: bigint("max_payout", { mode: "bigint" }).notNull(),
  minBullets: integer("min_bullets").notNull(),
  maxBullets: integer("max_bullets").notNull(),
  expReward: bigint("exp_reward", { mode: "bigint" }).notNull(),
  jailChancePercent: integer("jail_chance_percent").notNull(),
  jailSeconds: integer("jail_seconds").notNull(),
  sort: integer("sort").notNull(),
  braveCost: integer("brave_cost").notNull().default(0),
});

export const playerCrimeSkill = pgTable("player_crime_skill", {
  playerId: uuid("player_id").notNull(),
  crimeId: uuid("crime_id").notNull(),
  chance: numeric("chance", { precision: 5, scale: 2 }).notNull(),
});

export const crimeLog = pgTable("crime_log", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  crimeId: uuid("crime_id").notNull(),
  success: boolean("success").notNull(),
  payout: bigint("payout", { mode: "bigint" }).notNull(),
  jobId: text("job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Read mirrors of core-owned tables needed by the commit job.
 * The job has no ctx.player (null inside a job), so it must read
 * `players.username` for the actor name and `player_stats.jailedUntil`
 * for the in-tx effective-jail read (spec §4.4).
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
});
