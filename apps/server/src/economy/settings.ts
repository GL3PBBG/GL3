import { parseNonNegativeBigint } from "../game/hospital/settings.js";

/**
 * Core-owned economy settings (full keys, no plugin prefix — `loadSettings`
 * stores bare keys and only plugin `ctx.settings.get` namespacing adds one).
 * Same parser conventions as jail/hospital: malformed → default, never throw.
 */

const DEFAULT_WEALTH_TAX_PERCENT = 1;
const DEFAULT_WEALTH_TAX_THRESHOLD = 10_000_000n;

/**
 * Daily demurrage on banked wealth (see economy/tax.ts). 0 is valid and means
 * the tax is off — the operator's rollback — so only a non-integer falls back;
 * out-of-range integers clamp like jail's bailWealthPercent.
 */
export function wealthTaxPercent(settings: Record<string, string>): number {
  const raw = settings["economy.wealth_tax_percent"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_WEALTH_TAX_PERCENT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_WEALTH_TAX_PERCENT;
  return Math.min(100, Math.max(0, parsed));
}

/**
 * Balances at or below this pay nothing; above it, the percent applies to the
 * EXCESS only — demurrage that spares every ordinary account and touches only
 * parked wealth. One threshold for players and gangs alike.
 */
export function wealthTaxThreshold(settings: Record<string, string>): bigint {
  return parseNonNegativeBigint(settings["economy.wealth_tax_threshold"], DEFAULT_WEALTH_TAX_THRESHOLD);
}
