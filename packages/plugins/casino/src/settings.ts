/** Settings are read via ctx.settings.get(key), which resolves DB row `casino.<key>`. */
export const DEFAULT_MIN_BET = 100n;                // $100 — V2's PR_cost floor
export const DEFAULT_MAX_BET = 100_000n;            // $100,000, when no house lever is set
export const DEFAULT_SESSION_EXPIRY_MINUTES = 30;

interface SettingsReader { get(key: string): string | null }

function readBigint(settings: SettingsReader, key: string, fallback: bigint): bigint {
  const raw = settings.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  return BigInt(raw);
}

export function readMinBet(s: SettingsReader): bigint { return readBigint(s, "min_bet", DEFAULT_MIN_BET); }
export function readMaxBet(s: SettingsReader): bigint { return readBigint(s, "max_bet", DEFAULT_MAX_BET); }

/**
 * The ceiling on `session_expiry_minutes`: 100 years, in minutes.
 *
 * NOT a balance decision — it is what keeps the expiry ARITHMETIC valid.
 * `settings.value` is unbounded `text`, so an admin can store 400 digits;
 * `Number` answers `Infinity` for those, `Infinity > 0` passes the check
 * below, and `new Date(createdAt + Infinity * 60_000)` is an **Invalid Date**,
 * which compares `false` against every date. That comparison is exactly how
 * `index.ts` decides a hand is still live, so a false there means EVERY open
 * hand reads as expired: the lobby hides it and the next `play` forfeits it on
 * sight, costing the player their hand and the wager escrowed in it. A live
 * gameplay defect reachable from one settings row. The same Invalid Date also
 * blinded the admin Open-hands list's `stale` column — the diagnostic an admin
 * would reach for to find this very misconfiguration — which is a third reason
 * to clamp in the reader rather than at one call site.
 *
 * 100 years is picked so the clamp can never cost a legitimate configuration —
 * a hand that expires in a century does not expire — while keeping the span it
 * adds, 52_596_000 × 60_000 = 3.15576e12 ms, a factor of **2738** inside the
 * ±8.64e15 ms a `Date` can represent, so no plausible `created_at` can push
 * `createdAt + minutes` out of range. Clamping here rather than in `expiresAt`
 * covers all four call sites at once.
 */
export const MAX_SESSION_EXPIRY_MINUTES = 52_596_000; // 100 × 365.25 × 24 × 60

export function readExpiryMinutes(s: SettingsReader): number {
  const raw = s.get("session_expiry_minutes");
  if (raw === null || !/^\d+$/.test(raw)) return DEFAULT_SESSION_EXPIRY_MINUTES;
  const parsed = Number(raw);
  // Unchanged contract: non-positive falls back to the default. Written
  // `!(parsed > 0)` so a NaN — unreachable through the digits guard, but one
  // regex edit away — falls back rather than sailing through.
  if (!(parsed > 0)) return DEFAULT_SESSION_EXPIRY_MINUTES;
  // `Math.min(Infinity, MAX)` is MAX, so the absurd tail lands on the ceiling
  // rather than on a value no date arithmetic can survive.
  return Math.min(parsed, MAX_SESSION_EXPIRY_MINUTES);
}

export const DEFAULT_TABLE_BET_SECONDS = 20;
export const DEFAULT_TABLE_TURN_SECONDS = 30;
export const DEFAULT_TABLE_IDLE_KICK_HANDS = 3;
/** Hard ceiling; also the CHECK constraint's bound in migration 0003. */
export const MAX_TABLE_SEATS = 5;

function readPositiveInt(s: SettingsReader, key: string, fallback: number): number {
  const raw = s.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!(parsed > 0)) return fallback;
  return parsed;
}

export function readTableBetSeconds(s: SettingsReader): number {
  return readPositiveInt(s, "table_bet_seconds", DEFAULT_TABLE_BET_SECONDS);
}
export function readTableTurnSeconds(s: SettingsReader): number {
  return readPositiveInt(s, "table_turn_seconds", DEFAULT_TABLE_TURN_SECONDS);
}
export function readTableIdleKickHands(s: SettingsReader): number {
  return readPositiveInt(s, "table_idle_kick_hands", DEFAULT_TABLE_IDLE_KICK_HANDS);
}
/** Clamped into [1, MAX_TABLE_SEATS]: the seat_no CHECK is the backstop. */
export function readTableMaxSeats(s: SettingsReader): number {
  const parsed = readPositiveInt(s, "table_max_seats", MAX_TABLE_SEATS);
  return Math.min(parsed, MAX_TABLE_SEATS);
}
