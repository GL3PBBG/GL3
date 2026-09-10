import { z } from "zod";

/**
 * Default prizes for new rounds and legacy unsettled rounds, read from the
 * boot-loaded settings record. Admins can override prizes on individual rounds.
 *
 * `settings` is admin-edited free text written with SQL out of band (there is
 * no settings admin route in GL3, by design), so a typo here must not take a
 * request down: every failure mode degrades to DEFAULT_PAYOUT_POINTS and this
 * function never throws. A change to the row takes effect at the next restart,
 * like every other setting in the game — `loadSettings` reads the table once.
 */
const SETTING_KEY = "rounds.payout_points";
const DEFAULT_PAYOUT_POINTS: readonly bigint[] = [1000n, 500n, 250n];
/** Finalize runs inside one player's request; the award count must be bounded. */
const MAX_PAYOUT_PLACES = 100;

/** Admin form: comma-separated whole points in placing order. Blank means
 * use defaults on create / keep the existing schedule on edit; 0 disables prizes. */
export const RoundPayoutInputSchema = z.string().max(2200).optional()
  .transform((value) => value === undefined || value.trim() === "" ? undefined : value.split(",").map((v) => v.trim()))
  .pipe(z.array(z.string().regex(/^\d{1,19}$/)
    .refine((value) => /^\d{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n, "Points exceed the supported limit")
    .transform((value) => BigInt(value).toString())).min(1).max(MAX_PAYOUT_PLACES).optional())
  .transform((values) => values?.every((value) => value === "0") ? [] : values);

export function roundPayoutPoints(
  round: { payoutPoints: string[] | null }, settings: Record<string, string>,
): string[] {
  return round.payoutPoints ?? payoutPoints(settings).map(String);
}

const DIGITS = /^\d+$/;

function element(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === "string" && DIGITS.test(value)) return BigInt(value);
  return null;
}

export function payoutPoints(settings: Record<string, string>): bigint[] {
  const raw = settings[SETTING_KEY];
  // Explicit and first: "the admin cleared the field" must land on the default
  // deliberately, not by accident inside the catch below.
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_PAYOUT_POINTS];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_PAYOUT_POINTS];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_PAYOUT_POINTS];

  const awards: bigint[] = [];
  for (const item of parsed) {
    const value = element(item);
    // A partially-parsed award table is worse than the default: it silently
    // reorders the prizes.
    if (value === null) return [...DEFAULT_PAYOUT_POINTS];
    awards.push(value);
  }
  // An empty array is a legitimate configuration — "run rounds, pay nothing" —
  // and must NOT fall back.
  return awards.slice(0, MAX_PAYOUT_PLACES);
}
