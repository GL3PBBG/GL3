/**
 * V2's breakout chance, from the roster SQL in
 * modules/installed/jail/jail.inc.php:25-45 — see the 2026-08-31 spec §2.
 * The TARGET's level sets the difficulty; the caller's jailed state halves
 * it. V2's SQL `/ 2` yields fractional percents; we floor (spec-recorded
 * ≤0.5% divergence). The ELSE arm only ever sees levels ≤ 16, so the
 * linear branch bottoms out at 15 — no negative case exists.
 */
export function breakoutPercent(targetLevel: number, callerJailed: boolean, targetSuperMax: boolean): number {
  if (targetSuperMax) return 0;
  const base = targetLevel > 16 ? 10 : 95 - targetLevel * 5;
  return callerJailed ? Math.floor(base / 2) : base;
}

/**
 * The exact V2 userTimers key `migrators/timers.ts:15` imports — a migrated
 * V2 player's live super max works on day one BECAUSE these strings match.
 */
export const SUPER_MAX_KEY = "superMax";

/**
 * Replaces V2's timer-equality trick (jail.inc.php:23), which does not
 * survive GL3's separate jailed_until column: super max is live iff the
 * sentence is live AND the timer row is unexpired. A stale row left behind
 * by a cleared sentence is inert by this rule; sendToJail deletes it anyway
 * so a fresh sentence starts clean.
 */
export function superMaxLive(jailedUntil: Date | null, superMaxUntil: Date | null, now: Date = new Date()): boolean {
  if (jailedUntil === null || jailedUntil.getTime() <= now.getTime()) return false;
  return superMaxUntil !== null && superMaxUntil.getTime() > now.getTime();
}
