/**
 * The lazy income formula, pure. `now` is handed in by the caller (inside
 * the transaction) so tests never need a fake clock.
 *
 * Whole-hour units deliberately (spec §3): profit arrives in complete hours,
 * so a claim inside the first hour banks nothing — deterministic, and it
 * makes the double-claim case answer 0 without any extra state.
 */
export function accruedSince(
  lastClaimedAt: Date | null,
  rate: bigint,
  cap: bigint,
  now: Date,
): bigint {
  if (lastClaimedAt === null || rate <= 0n) return 0n;
  const elapsedMs = now.getTime() - lastClaimedAt.getTime();
  if (elapsedMs <= 0) return 0n;
  const wholeHours = BigInt(Math.floor(elapsedMs / 3_600_000));
  const accrued = rate * wholeHours;
  return accrued > cap ? cap : accrued;
}
