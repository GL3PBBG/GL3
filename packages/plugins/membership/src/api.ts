import { filterPoint, type PluginTx } from "@gl3/plugin-sdk";

export const MEMBERSHIP_TIMER_KEY = "membership";

export interface BenefitDecl { title: string; description: string }

/** Consumers subscribe with `on(benefits, ...)` to add display copy (casino.games shape). */
export const benefits = filterPoint<BenefitDecl[]>("membership.benefits");

/**
 * The live expiry, or null — and the lazy expiry notifier. An expired row is
 * deleted here, in the caller's transaction; `clear` returning true is the
 * atomic once-only claim (a concurrent caller's DELETE finds no row and
 * returns false), so exactly one "expired" notification is ever sent per
 * lapse. No cron, no Redis marker (NOTES.md rule 2 satisfied structurally).
 */
export async function membershipUntil(tx: PluginTx, playerId: string): Promise<Date | null> {
  const until = await tx.timers.get(playerId, MEMBERSHIP_TIMER_KEY);
  if (until === null) return null;
  if (until.getTime() > Date.now()) return until;
  const claimed = await tx.timers.clear(playerId, MEMBERSHIP_TIMER_KEY);
  if (claimed) await tx.notify(playerId, "Your premium membership has expired.");
  return null;
}

export async function isMember(tx: PluginTx, playerId: string): Promise<boolean> {
  return (await membershipUntil(tx, playerId)) !== null;
}
