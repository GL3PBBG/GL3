import { parseNonNegativeBigint, parsePositiveInt } from "../hospital/settings.js";

const DEFAULT_BAIL_COST_PER_SECOND = 1000n;
const DEFAULT_BUST_SUCCESS_PERCENT = 25;
const DEFAULT_BUST_FAIL_JAIL_SECONDS = 300;
const DEFAULT_ESCAPE_FAIL_EXTRA_SECONDS = 90;

export function bailCostPerSecond(settings: Record<string, string>): bigint {
  return parseNonNegativeBigint(settings["jail.bail_cost_per_second"], DEFAULT_BAIL_COST_PER_SECOND);
}

/**
 * Clamped rather than defaulted: an admin who types 250 meant "always", and
 * silently reverting that to 25 would be a worse surprise than honouring the
 * intent. Anything non-numeric still falls back like every other key.
 */
export function bustSuccessPercent(settings: Record<string, string>): number {
  const raw = settings["jail.bust_success_percent"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUST_SUCCESS_PERCENT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_BUST_SUCCESS_PERCENT;
  return Math.min(100, Math.max(0, parsed));
}

export function bustFailJailSeconds(settings: Record<string, string>): number {
  return parsePositiveInt(settings["jail.bust_fail_jail_seconds"], DEFAULT_BUST_FAIL_JAIL_SECONDS);
}

/** Added to the escaper's EXISTING sentence on a failed escape (V2's +90s). */
export function escapeFailExtraSeconds(settings: Record<string, string>): number {
  return parsePositiveInt(settings["jail.escape_fail_extra_seconds"], DEFAULT_ESCAPE_FAIL_EXTRA_SECONDS);
}
