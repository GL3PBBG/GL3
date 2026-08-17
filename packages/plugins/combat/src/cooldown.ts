/** Everything the pacing needs from a weapon. `dps` is the only new field. */
export interface CooldownProfile {
  damageMin: number;
  damageMax: number;
  /** Damage per second the weapon is allowed to sustain. Absent = unpaced. */
  dps?: number | undefined;
}

export interface CooldownBounds {
  /** The flat cooldown a weapon with no declared `dps` still gets. */
  cooldownSeconds: number;
  cooldownMaxSeconds: number;
}

/**
 * How long the attacker waits after firing this weapon, in whole seconds.
 *
 * A weapon declaring `dps` is paced by it: waiting `damage / dps` seconds means
 * the weapon deals exactly `dps` damage per second over the long run, so 10
 * damage at 1 dps waits 10 seconds and at 0.5 dps waits 20. A weapon that
 * declares none keeps the flat `combat.cooldown_seconds` — every migrated V2
 * item is in that case, since `itemEffects` has no such column.
 *
 * The divisor is the AVERAGE of the damage range, not the roll. The cooldown is
 * claimed before the transaction that rolls damage (the ordering that stops a
 * client probing targets for free), so the roll simply does not exist yet at
 * the point a TTL must be chosen — and averaging makes a weapon's rhythm a
 * property of the weapon rather than of luck.
 *
 * Pure with respect to time and RNG, like `resolve.ts`, so it tests exhaustively
 * without Postgres or Redis.
 *
 * Both clamps are load-bearing. The floor of 1 is the Redis one: `SET ... EX 0`
 * fails, which is the live `travel_cooldown_seconds = 0` crash. The cap stops
 * an admin's `dps: 0.001` turning a 10-damage weapon into a near-three-hour
 * lockout. `dps > 0` rather than `!== undefined` catches zero, negatives and
 * NaN in one guard — the schema refuses all three, but a hand-written row
 * reaches this function anyway and `10 / 0` is an `Infinity` TTL.
 */
export function cooldownSecondsFor(weapon: CooldownProfile, bounds: CooldownBounds): number {
  const dps = weapon.dps;
  if (dps === undefined || !(dps > 0)) return bounds.cooldownSeconds;
  const averageDamage = (weapon.damageMin + weapon.damageMax) / 2;
  const seconds = Math.ceil(averageDamage / dps);
  return Math.min(bounds.cooldownMaxSeconds, Math.max(1, seconds));
}
