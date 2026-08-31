import { parseNonNegativeBigint, parsePositiveInt } from "../hospital/settings.js";

const DEFAULT_BAIL_COST_PER_SECOND = 1000n;
const DEFAULT_BUST_FAIL_JAIL_SECONDS = 90;
const DEFAULT_ESCAPE_FAIL_EXTRA_SECONDS = 90;
const DEFAULT_BAIL_WEALTH_PERCENT = 1;
const DEFAULT_BAIL_WEALTH_CAP_MULTIPLIER = 10;

export function bailCostPerSecond(settings: Record<string, string>): bigint {
  return parseNonNegativeBigint(settings["jail.bail_cost_per_second"], DEFAULT_BAIL_COST_PER_SECOND);
}

/**
 * The wealth-scaling knobs for bail (see economy/wealth-fee.ts): the fee is
 * raised toward this percent of the PAYER's cash + bank, floored at the flat
 * fee above. 0 is valid and means flat — the operator's rollback — so only a
 * non-integer falls back, and out-of-range integers clamp the same way
 * dischargeWealthPercent does: an admin who types 150 meant "always max",
 * not the untouched default.
 */
export function bailWealthPercent(settings: Record<string, string>): number {
  const raw = settings["jail.bail_wealth_percent"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_BAIL_WEALTH_PERCENT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_BAIL_WEALTH_PERCENT;
  return Math.min(100, Math.max(0, parsed));
}

/** Ceiling multiple of the flat bail fee, whatever the payer's wealth. */
export function bailWealthCapMultiplier(settings: Record<string, string>): number {
  return parsePositiveInt(settings["jail.bail_wealth_cap_multiplier"], DEFAULT_BAIL_WEALTH_CAP_MULTIPLIER);
}

export function bustFailJailSeconds(settings: Record<string, string>): number {
  return parsePositiveInt(settings["jail.bust_fail_jail_seconds"], DEFAULT_BUST_FAIL_JAIL_SECONDS);
}

/** Added to the escaper's EXISTING sentence on a failed escape (V2's +90s). */
export function escapeFailExtraSeconds(settings: Record<string, string>): number {
  return parsePositiveInt(settings["jail.escape_fail_extra_seconds"], DEFAULT_ESCAPE_FAIL_EXTRA_SECONDS);
}
