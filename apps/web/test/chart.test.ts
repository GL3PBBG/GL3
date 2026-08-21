import { describe, expect, it } from "vitest";
import {
  barPath, countFractions, indexOfMax, layoutBars, moneyFractions,
  sparklinePath, sparklinePoints,
} from "../src/lib/chart.js";

describe("countFractions", () => {
  it("maps the maximum to 1 and scales the rest against it", () => {
    expect(countFractions([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it("returns zeros for an all-zero series instead of dividing by zero", () => {
    const fractions = countFractions([0, 0, 0]);
    expect(fractions).toEqual([0, 0, 0]);
    expect(fractions.every(Number.isFinite)).toBe(true);
  });

  it("returns an empty array for an empty series", () => {
    expect(countFractions([])).toEqual([]);
  });
});

describe("moneyFractions", () => {
  it("scales decimal strings against the largest", () => {
    expect(moneyFractions(["0", "250", "500"])).toEqual([0, 0.5, 1]);
  });

  it("is zero-safe across a range of empty days", () => {
    expect(moneyFractions(["0", "0"])).toEqual([0, 0]);
  });

  it("uses BigInt, so values past 2^53 stay distinguishable", () => {
    // As Numbers these two are the SAME value (9007199254740992), which is
    // exactly the collapse the decimal-string wire format exists to prevent.
    expect(Number("9007199254740993")).toBe(Number("9007199254740992"));

    const [smaller, larger] = moneyFractions(["9007199254740992", "9007199254740993"]);
    expect(larger).toBe(1);
    expect(smaller).toBeLessThan(1);
  });

  it("handles a figure far beyond float precision without overflowing", () => {
    const fractions = moneyFractions(["1000000000000000000000", "500000000000000000000"]);
    expect(fractions[0]).toBe(1);
    expect(fractions[1]).toBeCloseTo(0.5, 6);
  });
});

describe("indexOfMax", () => {
  it("points at the tallest bar", () => {
    expect(indexOfMax([0.2, 1, 0.5])).toBe(1);
  });

  it("returns -1 when every value is zero — there is no extreme to label", () => {
    expect(indexOfMax([0, 0, 0])).toBe(-1);
  });
});

describe("layoutBars", () => {
  it("gives the maximum the full plot height and an empty day none", () => {
    const bars = layoutBars(countFractions([0, 4]), { width: 100, height: 40 });
    expect(bars[0]?.height).toBe(0);
    expect(bars[0]?.y).toBe(40);
    expect(bars[1]?.height).toBe(40);
    expect(bars[1]?.y).toBe(0);
  });

  it("caps bar width so a short series does not become slabs", () => {
    const bars = layoutBars([1, 1], { width: 400, height: 40, maxBarWidth: 24 });
    for (const bar of bars) expect(bar.width).toBe(24);
  });

  it("keeps bars inside the plot and separated by the gap", () => {
    const bars = layoutBars(new Array(14).fill(1), { width: 280, height: 40, gap: 2 });
    expect(bars).toHaveLength(14);
    expect(bars[0]!.x).toBeGreaterThanOrEqual(0);
    expect(bars[13]!.x + bars[13]!.width).toBeLessThanOrEqual(280);
    expect(bars[1]!.x - (bars[0]!.x + bars[0]!.width)).toBeGreaterThanOrEqual(2);
  });

  it("clamps a fraction outside 0..1 rather than drawing past the plot", () => {
    const [over, under] = layoutBars([1.5, -1], { width: 100, height: 40 });
    expect(over!.height).toBe(40);
    expect(under!.height).toBe(0);
  });

  it("returns nothing for an empty series", () => {
    expect(layoutBars([], { width: 100, height: 40 })).toEqual([]);
  });
});

describe("barPath", () => {
  it("rounds the data end and squares the baseline", () => {
    const path = barPath({ x: 0, y: 10, width: 20, height: 30 }, 4);
    // Starts at the baseline corner and closes there — two quadratic curves,
    // both at the top.
    expect(path.startsWith("M0 40")).toBe(true);
    expect(path.split("Q")).toHaveLength(3);
    expect(path.endsWith("Z")).toBe(true);
  });

  it("draws nothing for a zero-height bar", () => {
    expect(barPath({ x: 0, y: 40, width: 20, height: 0 })).toBe("");
  });

  it("clamps the radius so a stub bar cannot fold its corners inside out", () => {
    const path = barPath({ x: 0, y: 39, width: 2, height: 1 }, 4);
    expect(path).not.toContain("NaN");
    expect(path).toContain("Q");
  });
});

describe("sparklinePoints / sparklinePath", () => {
  it("spans the full width and inverts the y axis", () => {
    const points = sparklinePoints([0, 1], { width: 100, height: 40 });
    expect(points[0]).toEqual({ x: 0, y: 40 });
    expect(points[1]).toEqual({ x: 100, y: 0 });
  });

  it("puts a lone point at the left edge instead of dividing by zero", () => {
    const points = sparklinePoints([0.5], { width: 100, height: 40 });
    expect(points).toEqual([{ x: 0, y: 20 }]);
  });

  it("produces an empty path for an empty series", () => {
    expect(sparklinePath(sparklinePoints([], { width: 100, height: 40 }))).toBe("");
  });

  it("emits one move and the rest lines", () => {
    const path = sparklinePath(sparklinePoints([0, 0.5, 1], { width: 100, height: 40 }));
    expect(path.startsWith("M")).toBe(true);
    expect(path.split("L")).toHaveLength(3);
  });
});
