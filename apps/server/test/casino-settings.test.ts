import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_EXPIRY_MINUTES, MAX_TABLE_SEATS, readExpiryMinutes, readMaxBet, readMinBet,
  readTableBetSeconds, readTableIdleKickHands, readTableMaxSeats, readTableTurnSeconds,
} from "@gl3/plugin-casino";

/**
 * The casino's settings readers — pure functions over a settings record, so
 * this needs neither Postgres nor Redis. `theft-settings.test.ts` is the
 * precedent for the shape.
 *
 * The expiry ceiling is the reason this file exists. `settings.value` is
 * unbounded `text`, and before the clamp a row of ~309+ digits read as
 * `Infinity`, which made `expiresAt` an Invalid Date — and an Invalid Date
 * compares false against every date, so every open hand read as expired and
 * `play` forfeited it on sight. `casino-lobby.test.ts`'s
 * "does not forfeit a live hand when the expiry setting is absurd" covers that
 * consequence end to end; this file covers the reader itself.
 */
const from = (rows: Record<string, string>) => ({
  get: (key: string): string | null => rows[key] ?? null,
});

describe("readMinBet / readMaxBet", () => {
  it("defaults on an empty settings table", () => {
    expect(readMinBet(from({}))).toBe(100n);
    expect(readMaxBet(from({}))).toBe(100_000n);
  });

  it("reads BARE keys — ctx.settings.get already namespaces by plugin id", () => {
    expect(readMinBet(from({ min_bet: "500" }))).toBe(500n);
    expect(readMaxBet(from({ max_bet: "900" }))).toBe(900n);
    // A reader asking for "casino.min_bet" would resolve
    // "casino.casino.min_bet" and silently default forever.
    expect(readMinBet(from({ "casino.min_bet": "500" }))).toBe(100n);
  });

  it("falls back on anything that is not a digit string, and has no ceiling", () => {
    expect(readMinBet(from({ min_bet: "10.00" }))).toBe(100n);
    expect(readMinBet(from({ min_bet: "-5" }))).toBe(100n);
    expect(readMinBet(from({ min_bet: "" }))).toBe(100n);
    // Money is bigint end to end, so a huge stake is representable exactly and
    // is NOT clamped — only the expiry feeds date arithmetic.
    const huge = "9".repeat(40);
    expect(readMaxBet(from({ max_bet: huge }))).toBe(BigInt(huge));
  });
});

describe("readExpiryMinutes", () => {
  it("defaults when unset or malformed", () => {
    expect(readExpiryMinutes(from({}))).toBe(30);
    expect(readExpiryMinutes(from({ session_expiry_minutes: "10.5" }))).toBe(30);
    expect(readExpiryMinutes(from({ session_expiry_minutes: "abc" }))).toBe(30);
  });

  it("keeps the non-positive fallback", () => {
    expect(readExpiryMinutes(from({ session_expiry_minutes: "0" }))).toBe(30);
  });

  it("reads a sane value, canonical or not", () => {
    expect(readExpiryMinutes(from({ session_expiry_minutes: "45" }))).toBe(45);
    expect(readExpiryMinutes(from({ session_expiry_minutes: "045" }))).toBe(45);
    // A year, and well under the ceiling: passed through untouched.
    expect(readExpiryMinutes(from({ session_expiry_minutes: "525600" }))).toBe(525_600);
  });

  it("clamps at the ceiling instead of answering something a Date cannot hold", () => {
    // At the ceiling: not clamped, since clamping is `Math.min`.
    expect(readExpiryMinutes(from({ session_expiry_minutes: String(MAX_SESSION_EXPIRY_MINUTES) })))
      .toBe(MAX_SESSION_EXPIRY_MINUTES);
    // One past it.
    expect(readExpiryMinutes(from({ session_expiry_minutes: String(MAX_SESSION_EXPIRY_MINUTES + 1) })))
      .toBe(MAX_SESSION_EXPIRY_MINUTES);
    // The magnitude that used to render as "1e+21" in the admin table.
    expect(readExpiryMinutes(from({ session_expiry_minutes: "1000000000000000000000" })))
      .toBe(MAX_SESSION_EXPIRY_MINUTES);
    // And the one that used to come back as Infinity.
    expect(readExpiryMinutes(from({ session_expiry_minutes: "9".repeat(400) })))
      .toBe(MAX_SESSION_EXPIRY_MINUTES);
  });

  it("yields a cutoff that still marks an old hand stale", () => {
    // `adminSessionsRoute`'s Open-hands `stale` column, evaluated in memory.
    // The expression is copied from the route: a cutoff built by subtracting
    // the reader's minutes from now, then `createdAt < cutoff`.
    //
    // Unclamped, the reader answers `Infinity`, the cutoff is an Invalid Date,
    // and `<` against an Invalid Date is FALSE for every row — so the column
    // read "no" for everything and went blind exactly when an admin would
    // reach for it. The DB-backed sibling in `casino-lobby.test.ts` cannot show
    // that: no route, admin surface or migration lets a caller set
    // `created_at`, so no old row can be got into the table. The comparison
    // needs no table.
    const minutes = readExpiryMinutes(from({ session_expiry_minutes: "9".repeat(400) }));
    const cutoff = new Date(Date.now() - minutes * 60_000);
    const ancientHand = new Date("1900-01-01T00:00:00Z");
    expect(ancientHand < cutoff).toBe(true);
  });

  it("answers a value every date arithmetic path can survive", () => {
    // The property that actually matters, asserted rather than argued: for the
    // worst input, `createdAt + minutes` is still a real date in the future.
    // This is the exact expression `index.ts`'s `expiresAt` computes.
    const minutes = readExpiryMinutes(from({ session_expiry_minutes: "9".repeat(400) }));
    const expiry = new Date(Date.now() + minutes * 60_000);
    expect(Number.isNaN(expiry.getTime())).toBe(false);
    expect(expiry.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("table settings", () => {
  it("defaults: 20s betting, 30s turns, 3 idle hands, 5 seats", () => {
    const s = from({});
    expect(readTableBetSeconds(s)).toBe(20);
    expect(readTableTurnSeconds(s)).toBe(30);
    expect(readTableIdleKickHands(s)).toBe(3);
    expect(readTableMaxSeats(s)).toBe(5);
  });

  it("reads configured values", () => {
    const s = from({
      table_bet_seconds: "45", table_turn_seconds: "10",
      table_idle_kick_hands: "1", table_max_seats: "3",
    });
    expect(readTableBetSeconds(s)).toBe(45);
    expect(readTableTurnSeconds(s)).toBe(10);
    expect(readTableIdleKickHands(s)).toBe(1);
    expect(readTableMaxSeats(s)).toBe(3);
  });

  it("clamps max seats to the hard ceiling and floors it at 1", () => {
    expect(readTableMaxSeats(from({ table_max_seats: "9" }))).toBe(MAX_TABLE_SEATS);
    expect(readTableMaxSeats(from({ table_max_seats: "0" }))).toBe(5);
  });

  it("falls back on malformed and non-positive values", () => {
    expect(readTableBetSeconds(from({ table_bet_seconds: "1.5" }))).toBe(20);
    expect(readTableTurnSeconds(from({ table_turn_seconds: "0" }))).toBe(30);
    expect(readTableIdleKickHands(from({ table_idle_kick_hands: "-2" }))).toBe(3);
  });
});
