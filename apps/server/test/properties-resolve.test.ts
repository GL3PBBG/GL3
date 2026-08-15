import { describe, expect, it } from "vitest";
import { accruedSince } from "@gl3/plugin-properties";

describe("accruedSince", () => {
  const HOUR = 3_600_000;

  it("returns 0n when lastClaimedAt is null", () => {
    expect(accruedSince(null, 500n, 10_000n, new Date())).toBe(0n);
  });

  it("returns 0n when rate is zero", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    expect(accruedSince(base, 0n, 10_000n, new Date(base.getTime() + 5 * HOUR))).toBe(0n);
  });

  it("returns 0n when rate is negative", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    expect(accruedSince(base, -1n, 10_000n, new Date(base.getTime() + 5 * HOUR))).toBe(0n);
  });

  it("returns 0n for negative elapsed (clock skew)", () => {
    const base = new Date("2026-01-01T01:00:00Z");
    const now = new Date("2026-01-01T00:30:00Z");
    expect(accruedSince(base, 500n, 10_000n, now)).toBe(0n);
  });

  it("returns 0n at exactly 59 minutes (not yet a whole hour)", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const now = new Date(base.getTime() + 59 * 60_000);
    expect(accruedSince(base, 500n, 10_000n, now)).toBe(0n);
  });

  it("returns rate for exactly one hour", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const now = new Date(base.getTime() + HOUR);
    expect(accruedSince(base, 500n, 10_000n, now)).toBe(500n);
  });

  it("returns rate * hours for multiple whole hours", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const now = new Date(base.getTime() + 3 * HOUR);
    expect(accruedSince(base, 500n, 10_000n, now)).toBe(1500n);
  });

  it("clamps to cap when accrual exceeds it", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const now = new Date(base.getTime() + 100 * HOUR);
    expect(accruedSince(base, 500n, 1000n, now)).toBe(1000n);
  });

  it("passes through uncapped when cap exceeds accrual", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const now = new Date(base.getTime() + 2 * HOUR);
    expect(accruedSince(base, 500n, 100_000n, now)).toBe(1000n);
  });

  it("passes through uncapped at exact cap boundary", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const now = new Date(base.getTime() + 2 * HOUR);
    expect(accruedSince(base, 500n, 1000n, now)).toBe(1000n);
  });
});
