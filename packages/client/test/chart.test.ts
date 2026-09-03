import { describe, expect, it } from "vitest";
import {
  barPath, barPathDown, countFractions, indexOfMax, layoutBars, layoutSignedBars,
  moneyFractions, signedFractions, sparklinePath, sparklinePoints, supplySeries,
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

describe("signedFractions", () => {
  it("scales against the largest magnitude in either direction", () => {
    expect(signedFractions(["100", "-50", "0"])).toEqual([1, -0.5, 0]);
  });

  it("is symmetric when the extremes match", () => {
    expect(signedFractions(["-300", "300"])).toEqual([-1, 1]);
  });

  it("returns zeros for an all-zero series", () => {
    expect(signedFractions(["0", "0"])).toEqual([0, 0]);
  });

  it("keeps figures past 2^53 distinct instead of collapsing onto one bar", () => {
    const big = "9007199254740993"; // 2^53 + 1
    const fractions = signedFractions([big, big, "-1"]);
    expect(fractions[0]).toBe(1);
    expect(fractions[1]).toBe(1);
    // The tiny sink must not round up to a visible bar.
    expect(fractions[2]!).toBeLessThan(0.000001);
  });
});

describe("layoutSignedBars", () => {
  it("puts the zero line at the bottom for an all-positive series — full height", () => {
    const { bars, zeroY } = layoutSignedBars([0.5, 1], { width: 100, height: 40 });
    expect(zeroY).toBe(40);
    expect(bars[1]).toMatchObject({ y: 0, height: 40 });
  });

  it("puts the zero line at the top for an all-negative series", () => {
    const { bars, zeroY } = layoutSignedBars([-0.5, -1], { width: 100, height: 40 });
    expect(zeroY).toBe(0);
    expect(bars[1]).toMatchObject({ y: 0, height: 40 });
  });

  it("splits the plot proportionally and keeps one scale across both directions", () => {
    // max up 1, max down 0.5 → scale 40/1.5 ≈ 26.67 px per unit, zero line at
    // 40 − 0.5 × 26.67 ≈ 26.67 from the top.
    const { bars, zeroY } = layoutSignedBars([1, -0.5, 0], { width: 300, height: 40 });
    const scale = 40 / 1.5;
    expect(zeroY).toBeCloseTo(40 - 0.5 * scale, 10);
    // toBeCloseTo, not equality: y lands on 0 only up to float rounding.
    expect(bars[0]!.y).toBeCloseTo(0, 10);
    expect(bars[0]!.height).toBeCloseTo(scale, 10);
    // Half the magnitude of bar[0], in the SAME pixels-per-unit.
    expect(bars[1]!.y).toBeCloseTo(zeroY, 10);
    expect(bars[1]!.height).toBeCloseTo(0.5 * scale, 10);
    expect(bars[2]?.height).toBe(0);
  });

  it("returns an empty layout for an empty series", () => {
    expect(layoutSignedBars([], { width: 100, height: 40 })).toEqual({ bars: [], zeroY: 40 });
  });
});

describe("barPathDown", () => {
  it("mirrors barPath: square at the top, rounded at the data end", () => {
    const path = barPathDown({ x: 0, y: 10, width: 10, height: 20 });
    expect(path.startsWith("M0 10")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    // The rounded corners are in the BOTTOM half (y ≈ 30), unlike barPath's.
    expect(path).toContain("Q0 30");
  });

  it("returns an empty path for a zero-height bar", () => {
    expect(barPathDown({ x: 0, y: 10, width: 10, height: 0 })).toBe("");
  });
});

describe("supplySeries", () => {
  it("reconstructs end-of-day supplies by walking today's balance backwards", () => {
    // Nets +100, -30, -30 from a 1000 start → end-of-day 1100, 1070, 1040.
    // An end-of-day figure INCLUDES that day's net — the last entry is
    // supplyNow itself.
    expect(supplySeries("1040", ["100", "-30", "-30"])).toEqual(["1100", "1070", "1040"]);
  });

  it("degrades to the flat present with no history", () => {
    expect(supplySeries("500", [])).toEqual([]);
  });

  it("stays exact past 2^53 — bigint end to end", () => {
    const big = "9007199254740992"; // 2^53
    // Day 0 moved nothing, day 1 minted one: end-of-day0 is big − 1, exactly.
    expect(supplySeries(big, ["0", "1"])).toEqual([(BigInt(big) - 1n).toString(), big]);
  });
});
