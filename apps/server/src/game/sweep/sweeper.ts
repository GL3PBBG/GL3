import { and, isNotNull, lte, or } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { playerStats } from "../../db/schema/index.js";
import { dischargeIfExpired } from "../hospital/status.js";
import { releaseIfExpiredWithOutcome } from "../jail/status.js";

/**
 * How many expired rows one pass will settle. Bounds the work a single tick
 * can do so a backlog (a restart after downtime, or the M4 import landing a
 * pile of already-expired sentences) drains over several ticks instead of
 * holding one long pass open. Anything left over is picked up next tick.
 */
export const SWEEP_BATCH_LIMIT = 500;

export interface SweepResult {
  /** Player ids whose jail sentence THIS pass ended. */
  released: string[];
  /** Player ids whose hospital stay THIS pass ended. */
  discharged: string[];
}

/**
 * One pass of the sentence sweeper: find sentences whose deadline has passed
 * and end them.
 *
 * The candidate SELECT takes no locks on purpose. Two servers — or two
 * overlapping passes — will happily pick the same row; the claim is the
 * UPDATE inside `releaseIfExpiredWithOutcome` / `dischargeIfExpired`, whose
 * `WHERE ... IS NOT NULL` matches for exactly one of them. That is where
 * CLAUDE.md rule 1's at-least-once idempotency comes from here: from the
 * statement, not from a bookkeeping table.
 *
 * Rows are settled ONE AT A TIME, never as a bulk `UPDATE ... WHERE
 * hospital_until <= now()`, which would take its row locks in scan order —
 * not sorted order — and could deadlock against combat's ascending
 * `lockPlayersForUpdate` (rule 6). The two settlement paths get there
 * differently, and both are deadlock-free for their own reason:
 *
 * - `dischargeIfExpired` (hospital) opens its own transaction and takes
 *   exactly one player lock through `lockPlayersForUpdate` before settling.
 *   A holder of a single lock has no outgoing wait edge and so cannot be
 *   part of a cycle.
 * - `releaseIfExpiredWithOutcome` (jail) takes no explicit lock at all: it is
 *   a bare SELECT followed by an `UPDATE ... WHERE jailed_until IS NOT NULL`,
 *   with no surrounding `db.transaction`. The UPDATE's row lock is acquired
 *   and released within that single autocommit statement, so no lock survives
 *   between statements — there is nothing left standing to form a wait edge,
 *   let alone a cycle.
 *
 * This is a latency optimisation, not the mechanism of record: the lazy path
 * on the gated routes still releases players if no sweeper is running at all.
 */
export async function sweepExpiredSentences(
  db: Db, redis: Redis, limit: number = SWEEP_BATCH_LIMIT,
): Promise<SweepResult> {
  const now = new Date();
  const candidates = await db.select({
    playerId: playerStats.playerId,
    jailedUntil: playerStats.jailedUntil,
    hospitalUntil: playerStats.hospitalUntil,
  })
    .from(playerStats)
    .where(or(
      and(isNotNull(playerStats.jailedUntil), lte(playerStats.jailedUntil, now)),
      and(isNotNull(playerStats.hospitalUntil), lte(playerStats.hospitalUntil, now)),
    ))
    .limit(limit);

  const result: SweepResult = { released: [], discharged: [] };
  for (const candidate of candidates) {
    if (candidate.jailedUntil !== null) {
      const { released } = await releaseIfExpiredWithOutcome(db, redis, candidate.playerId);
      if (released) result.released.push(candidate.playerId);
    }
    if (candidate.hospitalUntil !== null) {
      const { discharged } = await dischargeIfExpired(db, redis, candidate.playerId);
      if (discharged) result.discharged.push(candidate.playerId);
    }
  }
  return result;
}

export interface SweeperHandle {
  /** Stops the loop. Safe to call more than once. */
  stop: () => void;
}

export interface SweeperDeps {
  db: Db;
  redis: Redis;
  /** Milliseconds between the END of one pass and the START of the next. */
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/**
 * Runs `sweepExpiredSentences` on a loop.
 *
 * A self-scheduling `setTimeout` rather than `setInterval`: the delay is
 * measured from the END of each pass, so a slow pass can never overlap the
 * next one. Overlap would not corrupt anything — the claim UPDATE makes
 * double-settling impossible — but it would pile transactions onto a database
 * that is already the reason the pass was slow.
 *
 * A throwing pass is reported and swallowed. The loop must outlive a
 * transient Redis or Postgres blip; the lazy release path on the gated routes
 * is what keeps players correct while it is blipping.
 */
export function startSentenceSweeper(deps: SweeperDeps): SweeperHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      await sweepExpiredSentences(deps.db, deps.redis);
    } catch (error) {
      deps.onError?.(error);
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
