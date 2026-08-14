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
 * NOTES.md rule 1's at-least-once idempotency comes from here: from the
 * statement, not from a bookkeeping table.
 *
 * Rows are settled ONE AT A TIME, each in its own transaction holding exactly
 * one player lock. A bulk `UPDATE ... WHERE hospital_until <= now()` would
 * take its row locks in scan order, which is not sorted order, and could
 * deadlock against combat's ascending `lockPlayersForUpdate` (rule 6). A
 * holder of a single lock has no outgoing wait edge and so cannot be part of
 * a cycle.
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
