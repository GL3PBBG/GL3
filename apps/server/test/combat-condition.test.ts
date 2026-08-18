import { describe, expect, it } from "vitest";
import { backfireChanceFor, effectiveCondition, PRISTINE, repairCostFor } from "@gl3/plugin-combat";

const DAY = 86_400;
const at = (iso: string): Date => new Date(iso);

describe("effectiveCondition", () => {
  it("returns the stored value when no time has passed", () => {
    const t = at("2026-08-15T00:00:00Z");
    expect(effectiveCondition(80, t, t, DAY, 1)).toBe(80);
  });

  it("does not decay before a full period elapses", () => {
    expect(effectiveCondition(
      80, at("2026-08-15T00:00:00Z"), at("2026-08-15T23:59:59Z"), DAY, 1,
    )).toBe(80);
  });

  it("decays exactly one step at the period boundary", () => {
    expect(effectiveCondition(
      80, at("2026-08-15T00:00:00Z"), at("2026-08-16T00:00:00Z"), DAY, 1,
    )).toBe(79);
  });

  it("floors partial periods rather than rounding", () => {
    expect(effectiveCondition(
      80, at("2026-08-15T00:00:00Z"), at("2026-08-17T12:00:00Z"), DAY, 1,
    )).toBe(78);
  });

  it("clamps at zero rather than going negative", () => {
    expect(effectiveCondition(
      5, at("2026-01-01T00:00:00Z"), at("2026-08-15T00:00:00Z"), DAY, 1,
    )).toBe(0);
  });

  it("clamps at 100 for a stored value above it", () => {
    const t = at("2026-08-15T00:00:00Z");
    expect(effectiveCondition(140, t, t, DAY, 1)).toBe(100);
  });

  it("treats a future updatedAt as zero elapsed, never restoring condition", () => {
    expect(effectiveCondition(
      50, at("2026-08-20T00:00:00Z"), at("2026-08-15T00:00:00Z"), DAY, 1,
    )).toBe(50);
  });

  it("never decays when the rate is zero", () => {
    expect(effectiveCondition(
      50, at("2020-01-01T00:00:00Z"), at("2026-08-15T00:00:00Z"), DAY, 0,
    )).toBe(50);
  });

  it("PRISTINE is the value a missing row stands for", () => {
    expect(PRISTINE).toBe(100);
  });
});

describe("backfireChanceFor", () => {
  it("is the base chance on a pristine weapon", () => {
    expect(backfireChanceFor(2, 100, 3)).toBe(2);
  });

  it("is base times (1 + factor) on a ruined weapon", () => {
    expect(backfireChanceFor(2, 0, 3)).toBe(8);
  });

  it("interpolates at half condition", () => {
    expect(backfireChanceFor(2, 50, 3)).toBe(5);
  });

  it("stays zero for a weapon that declares zero, at any condition", () => {
    expect(backfireChanceFor(0, 0, 3)).toBe(0);
  });

  it("clamps at 100", () => {
    expect(backfireChanceFor(90, 0, 3)).toBe(100);
  });
});

describe("repairCostFor", () => {
  it("prices a full repair at multiplier x the weapon's price", () => {
    expect(repairCostFor(100_000n, 100, 3, 1000n)).toBe(300_000n);
  });

  it("scales linearly with points restored", () => {
    expect(repairCostFor(100_000n, 40, 3, 1000n)).toBe(120_000n);
  });

  it("rounds up rather than repairing tiny amounts for free", () => {
    // 33 * 3 * 1 / 100 = 0.99 — ceil, never floor to zero.
    expect(repairCostFor(33n, 1, 3, 1000n)).toBe(1n);
  });

  it("falls back to the flat per-point rate when the weapon has no price", () => {
    expect(repairCostFor(null, 40, 3, 1000n)).toBe(40_000n);
  });

  it("is zero for a zero-priced weapon", () => {
    expect(repairCostFor(0n, 40, 3, 1000n)).toBe(0n);
  });

  it("is zero when nothing is restored", () => {
    expect(repairCostFor(100_000n, 0, 3, 1000n)).toBe(0n);
  });
});
