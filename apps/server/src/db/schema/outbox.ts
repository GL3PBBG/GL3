import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The transactional outbox: side effects that must survive a crash between
 * COMMIT and their Redis/BullMQ delivery, written in the SAME transaction as
 * the facts they describe.
 *
 * Three kinds of row ride it:
 * - `event` — a fully-minted `GameEvent` envelope. `id` IS the envelope's
 *   uuidv7 event id, so the fast path after commit and a dispatcher retry
 *   publish byte-identical frames and the client's dedupe-on-`event.id`
 *   absorbs any at-least-once overlap.
 * - `score` — a leaderboard ZADD (final value per player+kind), carrying the
 *   prefix so test boots keep their key namespaces. Idempotent by nature;
 *   the boot-time `rebuildLeaderboards` remains the sweep-everything
 *   backstop.
 * - `job` — a plugin job enqueue: plugin id, job name, data and the seed
 *   minted at enqueue time. Dispatch is `queue.add(..., { jobId: row.id })`,
 *   so a crash between add and delete re-adds a no-op (BullMQ dedupes on
 *   jobId) and the worker-side `plugin_job_runs` claim remains the final
 *   idempotency guard.
 *
 * Rows are deleted the moment they are delivered — this table is a queue,
 * not an audit trail (notifications, ledger rows and combat_log are the
 * durable records). No foreign keys: a transient row must not take a lock
 * (rule 6) on anything, and `ON DELETE` semantics would be meaningless for
 * rows that outlive their referents only for milliseconds.
 *
 * `not_before` is the retry backoff stamp: the dispatcher claims a row by
 * advancing it, so two instances (or a pass racing the post-commit fast
 * path) at worst double-deliver — never drop, never hang.
 */
export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ notBeforeIdx: index("outbox_not_before_idx").on(t.notBefore) }));
