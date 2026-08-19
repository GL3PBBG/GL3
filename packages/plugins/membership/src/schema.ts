import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/** Owned and migrated by this plugin (migrations.ts). */
export const membershipPackages = pgTable("p_membership_packages", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  costPoints: bigint("cost_points", { mode: "bigint" }).notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
});

/** Read-only mirror of the core-owned table (bounties' pattern). */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});
