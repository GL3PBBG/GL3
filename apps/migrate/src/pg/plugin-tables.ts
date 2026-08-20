import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

/** Mirrors `packages/plugins/properties/src/migrations.ts` `0001_properties`. */
export const propertiesPlugin = pgTable("p_properties_properties", {
  id: uuid("id").primaryKey(),
  locationId: uuid("location_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  ownerPlayerId: uuid("owner_player_id"),
  cost: bigint("cost", { mode: "bigint" }).notNull(),
  profit: bigint("profit", { mode: "bigint" }).notNull(),
});

/** Mirrors `packages/plugins/theft/src/migrations.ts` `0001_cars`. */
export const cars = pgTable("p_theft_cars", {
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
export const garage = pgTable("p_theft_garage", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  carId: uuid("car_id").notNull(),
  damage: integer("damage").notNull().default(0),
  locationId: uuid("location_id"),
});

/** Mirrors `packages/plugins/forum/src/migrations.ts` `0001_forums`. */
export const forums = pgTable("p_forum_forums", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
});

/** Mirrors `packages/plugins/forum/src/migrations.ts` `0002_topics`. */
export const forumTopics = pgTable("p_forum_topics", {
  id: uuid("id").primaryKey(),
  forumId: uuid("forum_id").notNull(),
  authorId: uuid("author_id"),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("open"),
  type: text("type").notNull().default("normal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastPostAt: timestamp("last_post_at", { withTimezone: true }).notNull().defaultNow(),
  postCount: integer("post_count").notNull().default(0),
});

/** Mirrors `packages/plugins/forum/src/migrations.ts` `0004_posts`. */
export const forumPosts = pgTable("p_forum_posts", {
  id: uuid("id").primaryKey(),
  topicId: uuid("topic_id").notNull(),
  authorId: uuid("author_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Mirrors `packages/plugins/membership/src/migrations.ts` `0001_packages`. */
export const membershipPackages = pgTable("p_membership_packages", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  costPoints: bigint("cost_points", { mode: "bigint" }).notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
});
