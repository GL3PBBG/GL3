import { createRng } from "../rng.js";

/**
 * Pure so both branches are testable without a server. The route generates the
 * seed itself and never accepts one from the client — a client-chosen seed is
 * a client-chosen outcome.
 */
export function bustSucceeds(seed: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return createRng(seed).int(0, 100) < percent;
}
