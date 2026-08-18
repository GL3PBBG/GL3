import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const crimes = pgTable("crimes", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  cooldownSeconds: integer("cooldown_seconds").notNull(),
  minPayout: bigint("min_payout", { mode: "bigint" }).notNull(),
  maxPayout: bigint("max_payout", { mode: "bigint" }).notNull(),
  minBullets: integer("min_bullets").notNull().default(0),
  maxBullets: integer("max_bullets").notNull().default(0),
  expReward: bigint("exp_reward", { mode: "bigint" }).notNull().default(sql`0`),
  minRank: integer("min_rank").notNull().default(0),
  sort: integer("sort").notNull().default(0),
  /**
   * GL3 model addition, not present in V2's audited `crimes` columns (spec
   * §1.2 lists only C_cooldown/C_money/C_maxMoney/C_bullets/C_maxBullets/
   * C_exp/C_level) — V2's jail module clearly exists but the audit doesn't
   * say what decides which failed crimes jail you, so this is made explicit
   * rather than assumed. 0 means "never jails on failure."
   */
  jailChancePercent: integer("jail_chance_percent").notNull().default(0),
  jailSeconds: integer("jail_seconds").notNull().default(0),
}, (t) => ({ sortIdx: index("crimes_sort_idx").on(t.sort) }));

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  travelCost: bigint("travel_cost", { mode: "bigint" }).notNull().default(sql`0`),
  travelCooldownSeconds: integer("travel_cooldown_seconds").notNull().default(0),
  bulletStock: integer("bullet_stock").notNull().default(0),
  bulletCost: bigint("bullet_cost", { mode: "bigint" }).notNull().default(sql`0`),
  combatMode: text("combat_mode").notNull().default("open"),
});

export const weapons = pgTable("weapons", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  accuracy: integer("accuracy").notNull(),
});

/** V2 itemEffects/itemMeta EAV collapsed to JSONB (spec §1.2, §2.5). */
export const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  itemType: text("item_type").notNull(),
  effects: jsonb("effects").notNull().default({}),
  meta: jsonb("meta").notNull().default({}),
});
