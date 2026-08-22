/**
 * `settings` rows are admin-edited free text, so every parser here answers a
 * malformed value with the default rather than throwing on every request.
 * Blank is malformed on purpose: `BigInt("")` is 0n, not a throw, so a cleared
 * admin field would otherwise make discharge free.
 */
const DEFAULT_DISCHARGE_COST_PER_SECOND = 1000n;
const DEFAULT_CHECKIN_SECONDS_PER_HP = 30;
const DEFAULT_DISCHARGE_WEALTH_PERCENT = 1;
const DEFAULT_DISCHARGE_WEALTH_CAP_MULTIPLIER = 10;

export function parseNonNegativeBigint(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Strictly positive: 0 falls back too, not just negatives. `hospital.
 * checkin_seconds_per_hp = "0"` would otherwise write a stay whose deadline is
 * already past, so the next `GET /api/hospital` settles it straight back to
 * full — a free instant heal past the `not_injured` 409's whole point. Same
 * hole for `jail.bust_fail_jail_seconds = "0"`, which would make a failed
 * bust free.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function dischargeCostPerSecond(settings: Record<string, string>): bigint {
  return parseNonNegativeBigint(
    settings["hospital.discharge_cost_per_second"], DEFAULT_DISCHARGE_COST_PER_SECOND,
  );
}

/**
 * The wealth-scaling knobs for discharge (see economy/wealth-fee.ts): the fee
 * is raised toward this percent of the PAYER's cash + bank, floored at the
 * flat fee. 0 is the rollback to pure flat; out-of-range integers clamp the
 * same way jail's bustSuccessPercent does — typed intent beats silent default.
 */
export function dischargeWealthPercent(settings: Record<string, string>): number {
  const raw = settings["hospital.discharge_wealth_percent"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DISCHARGE_WEALTH_PERCENT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_DISCHARGE_WEALTH_PERCENT;
  return Math.min(100, Math.max(0, parsed));
}

/** Ceiling multiple of the flat discharge fee, whatever the payer's wealth. */
export function dischargeWealthCapMultiplier(settings: Record<string, string>): number {
  return parsePositiveInt(
    settings["hospital.discharge_wealth_cap_multiplier"], DEFAULT_DISCHARGE_WEALTH_CAP_MULTIPLIER,
  );
}

export function checkinSecondsPerHp(settings: Record<string, string>): number {
  return parsePositiveInt(settings["hospital.checkin_seconds_per_hp"], DEFAULT_CHECKIN_SECONDS_PER_HP);
}
