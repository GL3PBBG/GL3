import { sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Which plugin migrations have been applied. Core-owned, not prefixed
 * `p_<pluginId>_`: this is the loader's own bookkeeping, and a plugin cannot
 * reach it (spec: Table ownership).
 */
export const pluginMigrations = pgTable("plugin_migrations", {
  pluginId: text("plugin_id").notNull(),
  name: text("name").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ pk: primaryKey({ columns: [t.pluginId, t.name] }) }));

/**
 * NOTES.md rule 1 made structural: a job-context `ctx.transaction` inserts
 * here first, inside the same transaction as the handler's writes. BullMQ is
 * at-least-once, so a retry of an already-committed job hits this primary key
 * and aborts before re-applying any side effect. A plugin cannot forget the
 * idempotency key because it never writes one.
 */
export const pluginJobRuns = pgTable("plugin_job_runs", {
  pluginId: text("plugin_id").notNull(),
  jobId: text("job_id").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ pk: primaryKey({ columns: [t.pluginId, t.jobId] }) }));
