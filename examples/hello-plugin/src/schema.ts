import { sql } from "drizzle-orm";
import { integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/** Prefixed `p_hello_` — the loader rejects any other name for this plugin. */
export const greetings = pgTable("p_hello_greetings", {
  playerId: uuid("player_id").primaryKey(),
  count: integer("count").notNull().default(0),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull().default(sql`now()`),
});
