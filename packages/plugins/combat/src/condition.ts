/**
 * Weapon wear, as two pure functions. No I/O, no DB, no clock read — `now` is
 * a parameter — which is what lets the boundaries be tested exhaustively, the
 * same shape `resolve.ts` uses for the shot arithmetic.
 *
 * Decay is computed lazily from `updated_at` on every read rather than by a
 * sweeper job. That is not an optimisation: a BullMQ worker mutating condition
 * would need an idempotency key tied to `job.id` (NOTES.md rule 1), and there
 * is nothing here worth that risk.
 */

/** What a missing `p_combat_weapon_condition` row stands for. */
export const PRISTINE = 100;

function clamp(n: number): number {
  return Math.min(PRISTINE, Math.max(0, n));
}

/**
 * `stored` is the value written at `updatedAt`; this ages it forward to `now`.
 *
 * A future `updatedAt` — clock skew, or a row written by a machine running
 * ahead — clamps elapsed to 0 rather than RESTORING condition, which an
 * unguarded subtraction would do.
 *
 * `decayPeriodSeconds` is floored at 1 by `readCombatSettings`, so the
 * division here can never be by zero.
 */
export function effectiveCondition(
  stored: number,
  updatedAt: Date,
  now: Date,
  decayPeriodSeconds: number,
  decayPerPeriod: number,
): number {
  const elapsedSeconds = Math.max(0, (now.getTime() - updatedAt.getTime()) / 1000);
  const periods = Math.floor(elapsedSeconds / decayPeriodSeconds);
  return clamp(stored - periods * decayPerPeriod);
}

/**
 * Condition scales the weapon's own backfire chance as a MULTIPLIER, never as
 * an addend: a weapon declaring `backfireChance: 0` must stay at zero however
 * ruined it is, the same "an explicit zero survives the round trip" property
 * `accuracy: 0` already has in `WeaponEffectsSchema`.
 *
 * With the defaults (base 2, factor 3): pristine 2%, ruined 8%.
 */
export function backfireChanceFor(
  base: number,
  condition: number,
  wearFactor: number,
): number {
  const multiplier = 1 + ((PRISTINE - condition) / PRISTINE) * wearFactor;
  return Math.min(100, Math.round(base * multiplier));
}
