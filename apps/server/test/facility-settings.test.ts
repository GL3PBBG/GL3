import { describe, expect, it } from "vitest";
import { checkinSecondsPerHp, dischargeCostPerSecond } from "../src/game/hospital/settings.js";
import { bailCostPerSecond, bustFailJailSeconds, bustSuccessPercent, escapeFailExtraSeconds } from "../src/game/jail/settings.js";
import { bustSucceeds } from "../src/game/jail/bust.js";

/**
 * `settings` is admin-edited free text. A typo there must fall back to the
 * default rather than throw on every request — the rule the existing
 * `costPerSecond` comment in hospital/routes.ts states, applied to all five.
 * Note `BigInt("")` returns 0n rather than throwing, so blank has to be
 * rejected explicitly or a cleared admin field silently means "free".
 */
describe("facility settings parsers", () => {
  it("uses defaults when the keys are absent", () => {
    expect(dischargeCostPerSecond({})).toBe(1000n);
    expect(checkinSecondsPerHp({})).toBe(30);
    expect(bailCostPerSecond({})).toBe(1000n);
    expect(bustSuccessPercent({})).toBe(25);
    expect(bustFailJailSeconds({})).toBe(300);
    expect(escapeFailExtraSeconds({})).toBe(90);
  });

  it("reads well-formed values", () => {
    expect(checkinSecondsPerHp({ "hospital.checkin_seconds_per_hp": "5" })).toBe(5);
    expect(bailCostPerSecond({ "jail.bail_cost_per_second": "42" })).toBe(42n);
    expect(bustSuccessPercent({ "jail.bust_success_percent": "0" })).toBe(0);
    expect(bustSuccessPercent({ "jail.bust_success_percent": "100" })).toBe(100);
    expect(bustFailJailSeconds({ "jail.bust_fail_jail_seconds": "60" })).toBe(60);
    expect(escapeFailExtraSeconds({ "jail.escape_fail_extra_seconds": "120" })).toBe(120);
  });

  it.each(["", "   ", "abc", "-1", "1.5"])("falls back on %j", (raw) => {
    expect(checkinSecondsPerHp({ "hospital.checkin_seconds_per_hp": raw })).toBe(30);
    expect(bailCostPerSecond({ "jail.bail_cost_per_second": raw })).toBe(1000n);
    expect(bustFailJailSeconds({ "jail.bust_fail_jail_seconds": raw })).toBe(300);
    expect(escapeFailExtraSeconds({ "jail.escape_fail_extra_seconds": raw })).toBe(90);
  });

  it("rejects 0 for the parsers a zero-length stay would exploit", () => {
    // `parsePositiveInt` rejects <= 0, not just negatives — a zero
    // `checkin_seconds_per_hp` or `bust_fail_jail_seconds` would otherwise
    // write a sentence with a deadline already in the past, and a zero
    // `escape_fail_extra_seconds` would make escape a free reroll forever.
    expect(checkinSecondsPerHp({ "hospital.checkin_seconds_per_hp": "0" })).toBe(30);
    expect(bustFailJailSeconds({ "jail.bust_fail_jail_seconds": "0" })).toBe(300);
    expect(escapeFailExtraSeconds({ "jail.escape_fail_extra_seconds": "0" })).toBe(90);
  });

  it("clamps an out-of-range bust percentage instead of falling back", () => {
    expect(bustSuccessPercent({ "jail.bust_success_percent": "250" })).toBe(100);
    expect(bustSuccessPercent({ "jail.bust_success_percent": "-5" })).toBe(0);
  });

  it("never succeeds at 0 and always succeeds at 100", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      expect(bustSucceeds(seed, 0)).toBe(false);
      expect(bustSucceeds(seed, 100)).toBe(true);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(bustSucceeds("fixed-seed", 50)).toBe(bustSucceeds("fixed-seed", 50));
  });

  it("lands near the configured rate over many seeds", () => {
    const wins = Array.from({ length: 400 }, (_, i) => bustSucceeds(`seed-${i}`, 25))
      .filter(Boolean).length;
    expect(wins).toBeGreaterThan(60);
    expect(wins).toBeLessThan(140);
  });
});
