import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/** Owned and migrated by this plugin (migrations.ts). */
export const membershipPackages = pgTable("p_membership_packages", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  costPoints: bigint("cost_points", { mode: "bigint" }).notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
});

/** Read-only mirror of the core-owned table (bounties' pattern). The ip
 *  columns feed the gift route's same-IP pair check (anti-bot layer 3). */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
  signupIp: text("signup_ip"),
  lastIp: text("last_ip"),
});

/** Core-owned key/value, mirrored so the gift route reads its block flag
 *  LIVE inside the transaction (properties' skim-knob precedent). Never
 *  locked — stays out of the lock graph. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
