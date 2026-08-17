/** Settings are read via ctx.settings.get(key), which resolves DB row `casino.<key>`. */
export const DEFAULT_MIN_BET = 10_000n;             // $100 — V2's PR_cost floor
export const DEFAULT_MAX_BET = 10_000_000n;         // $100,000, when no house lever is set
export const DEFAULT_SESSION_EXPIRY_MINUTES = 30;

interface SettingsReader { get(key: string): string | null }

function readBigint(settings: SettingsReader, key: string, fallback: bigint): bigint {
  const raw = settings.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  return BigInt(raw);
}

export function readMinBet(s: SettingsReader): bigint { return readBigint(s, "min_bet", DEFAULT_MIN_BET); }
export function readMaxBet(s: SettingsReader): bigint { return readBigint(s, "max_bet", DEFAULT_MAX_BET); }

export function readExpiryMinutes(s: SettingsReader): number {
  const raw = s.get("session_expiry_minutes");
  if (raw === null || !/^\d+$/.test(raw)) return DEFAULT_SESSION_EXPIRY_MINUTES;
  const parsed = Number(raw);
  return parsed > 0 ? parsed : DEFAULT_SESSION_EXPIRY_MINUTES;
}
