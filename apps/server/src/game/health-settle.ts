export interface HealthSettlement {
  readonly health: number;
  readonly max: number;
  readonly stamp: Date | null;
}

/**
 * MCCodes hp regen, pure (audit §1.1): ⅓ of max per 5-minute tick, applied
 * batch-then-round-once — `round(intervals × max / 3)` — exactly how the
 * cronless emulator applies N missed increments in one statement. The
 * `settlePool` discipline throughout: whole intervals only, the stamp
 * advances to the deadline it cleared (never `now`, so the remainder
 * survives), and an already-full pool jumps the stamp to now so it accrues
 * no debt.
 *
 * A non-positive max is "not ours": the caller treats it as rank-derived
 * GL3-native health, untouched and byte-identical.
 */
export function settleHealth(
  health: number,
  max: number,
  stampedAt: Date | null,
  now: Date,
): HealthSettlement {
  if (max <= 0) return { health, max, stamp: stampedAt };

  if (stampedAt === null) return { health, max, stamp: now };
  if (health >= max) return { health, max, stamp: now };

  const REGEN_INTERVAL_SECONDS = 300;
  const elapsedSeconds = (now.getTime() - stampedAt.getTime()) / 1000;
  const intervals = Math.floor(elapsedSeconds / REGEN_INTERVAL_SECONDS);
  if (intervals <= 0) return { health, max, stamp: stampedAt };

  return {
    health: Math.min(max, health + Math.round((intervals * max) / 3)),
    max,
    stamp: new Date(stampedAt.getTime() + intervals * REGEN_INTERVAL_SECONDS * 1000),
  };
}
