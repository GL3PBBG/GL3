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
  /**
   * MCCodes `crimes.crimeBRAVE` — what a commit costs in the brave pool.
   * Priced iff the brave pool is declared by an installed plugin (audit §7
   * item 13); 0 means the crime costs no brave, including every GL3-native
   * crime forever.
   */
  braveCost: integer("brave_cost").notNull().default(0),
  /**
   * MCCodes `crimes.crimePERCFORM`, translated into the sandboxed five-token
   * dialect (LEVEL/CRIMEXP/EXP/WILL/IQ; arithmetic plus
   * min/max/floor/ceil/round/abs). NULL = GL3-native per-player skill chance —
   * the two models are mutually exclusive per crime, and the migrator imports
   * NULL with a report entry whenever a source formula doesn't fit the
   * dialect (spec 2026-08-26-mccodes-mechanics-audit §7 item 5).
   */
  successFormula: text("success_formula"),
}, (t) => ({ sortIdx: index("crimes_sort_idx").on(t.sort) }));

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  travelCost: bigint("travel_cost", { mode: "bigint" }).notNull().default(sql`0`),
  travelCooldownSeconds: integer("travel_cooldown_seconds").notNull().default(0),
  bulletStock: integer("bullet_stock").notNull().default(0),
  bulletCost: bigint("bullet_cost", { mode: "bigint" }).notNull().default(sql`0`),
  combatMode: text("combat_mode").notNull().default("open"),
  /** Travel gate from MCCodes `cities.cityminlevel`; 0 = no gate. */
  minLevel: integer("min_level").notNull().default(0),
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
