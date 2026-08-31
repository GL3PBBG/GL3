import { describe, expect, it } from "vitest";
import { breakoutPercent, superMaxLive, SUPER_MAX_KEY } from "../src/game/jail/breakout.js";

describe("breakoutPercent (V2 jail.inc.php:25-45)", () => {
  it("derives from the TARGET's level, linear arm", () => {
    expect(breakoutPercent(1, false, false)).toBe(90);
    expect(breakoutPercent(16, false, false)).toBe(15);
  });
  it("clamps levels above 16 to 10", () => {
    expect(breakoutPercent(17, false, false)).toBe(10);
    expect(breakoutPercent(99, false, false)).toBe(10);
  });
  it("halves (floored) when the caller is jailed — self-escape and inmate busts", () => {
    expect(breakoutPercent(1, true, false)).toBe(45);
    expect(breakoutPercent(16, true, false)).toBe(7); // 15/2 floored — the recorded 0.5% divergence
    expect(breakoutPercent(17, true, false)).toBe(5);
  });
  it("is 0 against a super-maxed target regardless of everything else", () => {
    expect(breakoutPercent(1, false, true)).toBe(0);
    expect(breakoutPercent(1, true, true)).toBe(0);
  });
});

describe("superMaxLive", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const future = new Date("2026-08-31T13:00:00Z");
  const past = new Date("2026-08-31T11:00:00Z");
  it("requires BOTH a live sentence and a live timer", () => {
    expect(superMaxLive(future, future, now)).toBe(true);
    expect(superMaxLive(null, future, now)).toBe(false);     // not jailed → stale timer is inert
    expect(superMaxLive(past, future, now)).toBe(false);     // sentence over
    expect(superMaxLive(future, null, now)).toBe(false);     // no timer row
    expect(superMaxLive(future, past, now)).toBe(false);     // timer expired
  });
});

describe("SUPER_MAX_KEY", () => {
  it("matches the migrator's V2 key verbatim — the zero-migration contract", () => {
    expect(SUPER_MAX_KEY).toBe("superMax");
  });
});
