import { asc, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { GameEventSchema, LeaderboardKindSchema, type GameEvent, type LeaderboardKind } from "@gl3/shared";
import type { Db } from "../db/client.js";
import type { Tx } from "../economy/ledger.js";
import { outbox } from "../db/schema/index.js";
import { publishEvent } from "./publish.js";
import { DEFAULT_LEADERBOARD_PREFIX, recordScore } from "../game/leaderboard/service.js";

/**
 * The transactional outbox's delivery side. Rows are written inside the same
 * transaction as the facts (see schema/outbox.ts for the three kinds); this
 * module delivers them, twice over:
 *
 * - the FAST PATH runs immediately after COMMIT, holding the freshly-inserted
 *   rows in memory, so the happy path's latency is exactly what it was before
 *   the outbox existed;
 * - the DISPATCHER (`settleOutboxOnce` behind `startOutboxLoop`) is the
 *   recovery: it re-delivers whatever the fast path could not — a Redis
 *   blip, a BullMQ outage, or a process that died between COMMIT and flush.
 *
 * Delivery is at-least-once everywhere: a crash between "delivered" and
 * "deleted" simply re-delivers, and every kind of row is safe to replay —
 * event envelopes carry their own id (clients dedupe on `event.id`),
 * leaderboard ZADDs are last-write-wins, and job enqueues dedupe on the
 * BullMQ jobId. That is the same contract BullMQ itself already gives the
 * job workers (`plugin_job_runs`), extended to the bus.
 */

/** How many rows one dispatcher pass claims. Backlogs drain over several ticks. */
export const OUTBOX_BATCH_LIMIT = 100;

export type OutboxKind = "event" | "score" | "job";

/** A row as its producer writes it (before the table stamps its defaults). */
export interface OutboxRowInput {
  /** The event envelope's own id, or the minted jobId — uuidv7, so insertion order survives to dispatch order. */
  id: string;
  kind: OutboxKind;
  payload: unknown;
}

/** A row as delivery sees it, whether it arrived from an INSERT's returning() or a dispatcher claim. */
export interface OutboxClaimedRow {
  id: string;
  kind: string;
  payload: unknown;
}

/** A score row's payload. `score` is a decimal string — money is never a JSON number. */
export interface OutboxScorePayload {
  leaderboard: LeaderboardKind;
  playerId: string;
  score: string;
  prefix: string;
}

/** A job row's payload — everything `queue.add` needs, seed included. */
export interface OutboxJobPayload {
  pluginId: string;
  jobName: string;
  data: Record<string, unknown>;
  seed: string;
}

/**
 * Resolves a plugin's BullMQ queue for job delivery. Returns undefined when
 * the plugin (or job) is not loaded — the row is then dropped with a loud
 * log, because a job for a queue that cannot exist can never run and must
 * not hang the queue forever.
 */
export type QueueResolver = (pluginId: string, jobName: string) => Queue | undefined;

export interface OutboxDispatchDeps {
  redis: Redis;
  queueResolver?: QueueResolver;
  /** Where delivery failures are reported. Defaults to console.error — the same fallback 3e3e5d7 established for log lines that must survive a silenced test-environment logger. */
  onError?: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * Delivers one row. Throws on delivery failure (the row stays for retry);
 * throws `UndeliverableRowError` when the row can never be delivered —
 * corrupt payload, unroutable job, unknown kind — and must be dropped
 * loudly instead of retried forever.
 */
class UndeliverableRowError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The score/job rows' payloads get the same treatment the event envelope
 * always had: validated at the delivery boundary, because the row went
 * through JSON after being built from structurally-typed code. A payload
 * that cannot parse can never deliver — without this check a corrupt score
 * row would throw inside BigInt(undefined), be retained, and retry forever
 * (the no-poison-drop stance is premised on validation, so validation has
 * to actually happen for every kind).
 */
const OutboxScorePayloadSchema = z.object({
  leaderboard: LeaderboardKindSchema,
  playerId: z.string().uuid(),
  // Decimal string, never a JSON number — money rules apply here too.
  score: z.string().regex(/^\d+$/, "score must be a nonnegative decimal string"),
  prefix: z.string().min(1),
}).strict();

const OutboxJobPayloadSchema = z.object({
  pluginId: z.string().min(1),
  jobName: z.string().min(1),
  data: z.record(z.unknown()),
  seed: z.string(),
}).strict();

async function deliverRow(deps: OutboxDispatchDeps, row: OutboxClaimedRow): Promise<void> {
  if (row.kind === "event") {
    // The envelope was validated at mint; the row then went through JSON, so
    // this parse is re-deriving the type honestly (no cast) and doubles as
    // the corrupt-row guard — a payload that cannot parse can never deliver
    // and is dropped loudly rather than retried forever.
    const parsed = GameEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      throw new UndeliverableRowError(`outbox event row "${row.id}" failed envelope validation — dropping`);
    }
    await publishEvent(deps.redis, parsed.data);
    return;
  }
  if (row.kind === "score") {
    const parsed = OutboxScorePayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      throw new UndeliverableRowError(`outbox score row "${row.id}" failed payload validation — dropping`);
    }
    const { leaderboard, playerId, score, prefix } = parsed.data;
    await recordScore(deps.redis, leaderboard, playerId, BigInt(score), prefix || DEFAULT_LEADERBOARD_PREFIX);
    return;
  }
  if (row.kind === "job") {
    const parsed = OutboxJobPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      throw new UndeliverableRowError(`outbox job row "${row.id}" failed payload validation — dropping`);
    }
    const { pluginId, jobName, data, seed } = parsed.data;
    const queue = deps.queueResolver?.(pluginId, jobName);
    if (queue === undefined) {
      throw new UndeliverableRowError(
        `outbox job row "${row.id}" targets plugin "${pluginId}" job "${jobName}", which is not loaded — dropping`,
      );
    }
    // The row id IS the jobId, so a crash between add and delete re-adds a
    // no-op: BullMQ keeps the job under the same id and the worker-side
    // plugin_job_runs claim is the final idempotency guard.
    await queue.add(jobName, { ...data, seed }, { jobId: row.id });
    return;
  }
  throw new UndeliverableRowError(`outbox row "${row.id}" has unknown kind "${row.kind}" — dropping`);
}

/**
 * Adapts a fastify-style logger (or anything with `error(obj, message)`) to
 * the outbox error sink, so core routes report delivery failures through
 * their request log instead of the console fallback.
 */
export function outboxErrorLog(
  log: { error: (fields: object, message: string) => void },
): (error: unknown, context: Record<string, unknown>) => void {
  return (error, context) => {
    log.error({ err: error, ...context }, "outbox delivery failed");
  };
}

/**
 * The domain-facing delivery port: hands committed outbox rows to the
 * delivery machinery. Domain modules — jail/hospital status, rounds settle,
 * the sentence sweeper, the facility routes — take THIS and never a Redis
 * client, the structural form of "game rules should not know Redis exists":
 * the Redis (and BullMQ) knowledge lives in this module and the composition
 * roots that call `createOutboxDelivery`. The optional per-call error sink
 * is how a route logs through its own request logger without the domain
 * knowing fastify either.
 */
export type OutboxDelivery = (
  rows: readonly OutboxClaimedRow[],
  onError?: (error: unknown, context: Record<string, unknown>) => void,
) => Promise<void>;

/** Builds the `OutboxDelivery` port over one db and one dispatch deps set. */
export function createOutboxDelivery(db: Db, deps: OutboxDispatchDeps): OutboxDelivery {
  // The result counts are the machinery's business; the port answers void —
  // callers cannot branch on delivery internals they should not see.
  return async (rows, onError) => {
    await deliverAndClear(db, onError === undefined ? deps : { ...deps, onError }, rows);
  };
}

/**
 * Inserts already-minted core envelopes as event rows, inside the caller's
 * own transaction — the core-routes counterpart of the plugin ctx's
 * automatic buffering. Returns the row shapes so the caller can hand the
 * SAME rows (ids and all) to `deliverAndClear` after commit.
 */
export async function insertOutboxEvents(
  tx: Tx, events: readonly GameEvent[],
): Promise<OutboxClaimedRow[]> {
  const rows = events.map((event) => ({ id: event.id, kind: "event", payload: event }));
  if (rows.length > 0) await tx.insert(outbox).values(rows);
  return rows;
}

/**
 * Process-local delivery counters — the operations half of "rows are
 * deleted on delivery, so the table cannot tell you delivery latency".
 * The table answers backlog questions (see `GET /api/admin/outbox`); these
 * answer throughput and health-of-the-delivery-path questions since boot.
 * Per-process by design (the table is the cross-process truth); reset on
 * restart, like every Redis-native counter in this codebase.
 */
export interface OutboxStats {
  delivered: number;
  /** Delivery attempts that failed and left the row for retry. */
  failedAttempts: number;
  /** Rows dropped as undeliverable — corrupt payload, unroutable job, unknown kind. */
  dropped: number;
  lastDeliveredAt: string | null;
  lastErrorAt: string | null;
}

const stats: OutboxStats = {
  delivered: 0, failedAttempts: 0, dropped: 0, lastDeliveredAt: null, lastErrorAt: null,
};

/** A read-only copy — callers must not be able to mutate the module's own counters. */
export function readOutboxStats(): OutboxStats {
  return { ...stats };
}

/**
 * Delivers every row it can and deletes exactly the rows that are done —
 * delivered, or unroutable-by-construction. A row whose delivery THREW is
 * left in place for the dispatcher. This function never throws at all: it
 * runs in the post-commit fast path, where the caller's facts are already
 * durable and a delivery blip must not turn committed work into a 500 — the
 * old let-it-throw stance existed because a lost push was lost forever; the
 * outbox dissolves it.
 */
export async function deliverAndClear(
  db: Db, deps: OutboxDispatchDeps, rows: readonly OutboxClaimedRow[],
): Promise<{ delivered: number; retained: number }> {
  const done: string[] = [];
  let delivered = 0;
  for (const row of rows) {
    try {
      await deliverRow(deps, row);
      done.push(row.id);
      delivered += 1;
    } catch (error) {
      stats.lastErrorAt = new Date().toISOString();
      if (error instanceof UndeliverableRowError) {
        done.push(row.id);
        stats.dropped += 1;
        (deps.onError ?? console.error)(error, { outboxRow: row.id });
      } else {
        stats.failedAttempts += 1;
        (deps.onError ?? console.error)(error, {
          outboxRow: row.id, kind: row.kind, retained: "dispatcher will retry",
        });
      }
    }
  }
  if (delivered > 0) {
    stats.delivered += delivered;
    stats.lastDeliveredAt = new Date().toISOString();
  }
  if (done.length > 0) {
    try {
      await db.delete(outbox).where(inArray(outbox.id, done));
    } catch (error) {
      // Delivered but not deleted: the dispatcher will re-deliver — every
      // kind of row is replay-safe by construction. Loud, not fatal.
      (deps.onError ?? console.error)(error, { outboxRows: done, retained: "delivered; delete failed, will re-deliver" });
      return { delivered, retained: rows.length };
    }
  }
  return { delivered, retained: rows.length - done.length };
}

/**
 * One dispatcher pass: claim a bounded batch, deliver it, delete what
 * delivered.
 *
 * The claim is a guarded UPDATE — the sentence sweeper's idiom, not a SKIP
 * LOCKED (this repo has none): the sub-SELECT picks ready rows, the UPDATE
 * stamps `attempts + 1` and pushes `not_before` into a capped exponential
 * backoff, and a second dispatcher (or a pass racing the fast path) either
 * sees the row before the stamp and double-delivers — harmless, every kind
 * is replay-safe — or after it and skips it until the backoff expires. A
 * crash mid-pass leaves claimed rows stamped, so the next pass retries them
 * after the backoff: nothing is lost, nothing hangs.
 */
export async function settleOutboxOnce(
  db: Db, deps: OutboxDispatchDeps, limit = OUTBOX_BATCH_LIMIT,
): Promise<{ claimed: number; delivered: number; retained: number }> {
  const claimed = await db
    .update(outbox)
    .set({
      attempts: sql`${outbox.attempts} + 1`,
      // The SET expressions see the pre-update row, so this exponent is the
      // attempt number being made now: 1s, 2s, 4s … capped at 60s.
      notBefore: sql`now() + make_interval(secs => least(60, power(2, ${outbox.attempts})))`,
    })
    .where(inArray(
      outbox.id,
      db.select({ id: outbox.id }).from(outbox)
        .where(lte(outbox.notBefore, sql`now()`))
        .orderBy(asc(outbox.id))
        .limit(limit),
    ))
    .returning({ id: outbox.id, kind: outbox.kind, payload: outbox.payload });
  if (claimed.length === 0) return { claimed: 0, delivered: 0, retained: 0 };

  const { delivered, retained } = await deliverAndClear(db, deps, claimed);
  return { claimed: claimed.length, delivered, retained };
}

export interface OutboxLoopDeps extends OutboxDispatchDeps {
  db: Db;
  /** Milliseconds between the END of one pass and the START of the next. */
  intervalMs: number;
}

export interface OutboxLoopHandle {
  /** Stops the loop. Safe to call more than once. */
  stop: () => void;
}

/**
 * Runs `settleOutboxOnce` on a loop — the sentence sweeper's shape verbatim:
 * a self-scheduling `setTimeout` (delay from the END of a pass, so passes
 * never pile up) whose throwing passes are reported and swallowed, because
 * the loop must outlive a transient Postgres or Redis blip.
 */
export function startOutboxLoop(deps: OutboxLoopDeps): OutboxLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      await settleOutboxOnce(deps.db, deps);
    } catch (error) {
      deps.onError?.(error, { pass: "settleOutboxOnce" });
    }
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, deps.intervalMs);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
