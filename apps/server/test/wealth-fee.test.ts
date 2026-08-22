import { describe, expect, it } from "vitest";
import { wealthScaledFee } from "../src/economy/wealth-fee.js";

/**
 * Pure-function coverage for the wealth-scaled fee. The integration behaviour
 * (who pays, which ledger reason, locking) lives in the jail/hospital/
 * detectives suites; this file pins the arithmetic contract: floor, cap,
 * ceiling rounding, and the two degenerate knobs.
 */
describe("wealthScaledFee", () => {
  it("returns the flat fee when percent is 0 — the rollback knob", () => {
    expect(wealthScaledFee(600_000n, 999_999_999n, 0, 10)).toBe(600_000n);
  });

  it("returns the flat fee as the floor for a poor payer", () => {
    // 1% of 10M is 100k, below the 600k flat fee — the flat fee wins.
    expect(wealthScaledFee(600_000n, 10_000_000n, 1, 10)).toBe(600_000n);
  });

  it("scales to the percent of wealth above the floor", () => {
    // 1% of 500M = 5M, above the floor, below the cap.
    expect(wealthScaledFee(600_000n, 500_000_000n, 1, 10)).toBe(5_000_000n);
  });

  it("caps at flat × capMultiplier for extreme wealth", () => {
    // 1% of 50B = 500M, but the cap is 600k × 10 = 6M.
    expect(wealthScaledFee(600_000n, 50_000_000_000n, 1, 10)).toBe(6_000_000n);
  });

  it("rounds the percent up, never down", () => {
    // 1% of 10,000,600,000 = 100,006,000 exactly — add 1 to wealth and the
    // exact figure lands on 100,006,000.01, which must charge 100,006,001.
    expect(wealthScaledFee(1_000n, 10_000_600_001n, 1, 1_000_000)).toBe(100_006_001n);
    // Same check at a boundary: exactly on the cent stays exact.
    expect(wealthScaledFee(1_000n, 10_000_600_000n, 1, 1_000_000)).toBe(100_006_000n);
  });

  it("keeps a free facility free — flat 0 beats any wealth", () => {
    expect(wealthScaledFee(0n, 1_000_000_000_000n, 100, 10)).toBe(0n);
  });

  it("uses cash + bank as the caller passes it — bank is not a shelter", () => {
    // Documented by contrast: same formula, wealth split across balances.
    const cashOnly = wealthScaledFee(600_000n, 100_000_000n, 1, 10);
    const cashPlusBank = wealthScaledFee(600_000n, 100_000_000n + 400_000_000n, 1, 10);
    expect(cashOnly).toBe(1_000_000n);
    expect(cashPlusBank).toBe(5_000_000n);
  });
});
