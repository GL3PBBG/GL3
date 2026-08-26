import { describe, expect, it } from "vitest";
import { settlePool, type AttributePoolDecl } from "../src/attributes.js";

const DECL: AttributePoolDecl = {
  pool: "energy", defaultMax: 100, regenAmount: 5, regenIntervalSeconds: 60,
};
const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("settlePool", () => {
  it("is a total no-op when no plugin declares the pool", () => {
    const out = settlePool(3, 50, T0, at(9999), null);
    expect(out).toEqual({ value: 3, max: 50, stamp: T0 });
  });

  it("seeds an uninitialised max from the declaration", () => {
    const out = settlePool(0, 0, T0, at(60), DECL);
    expect(out.max).toBe(100);
  });

  it("starts the clock on a null stamp without accruing anything", () => {
    const out = settlePool(0, 100, null, at(9999), DECL);
    expect(out.value).toBe(0);
    expect(out.stamp).toEqual(at(9999));
  });

  it("grants whole intervals only", () => {
    const out = settlePool(0, 100, T0, at(150), DECL);
    expect(out.value).toBe(10);
  });

  it("keeps the remainder by advancing the stamp to the deadline it cleared, not to now", () => {
    // This is the regression: stamping `now` would silently eat 30 seconds.
    const first = settlePool(0, 100, T0, at(150), DECL);
    expect(first.stamp).toEqual(at(120));

    const second = settlePool(first.value, first.max, first.stamp, at(180), DECL);
    expect(second.value).toBe(15); // floor(180 / 60) * 5, not 10
  });

  it("leaves everything untouched when less than one interval has passed", () => {
    const out = settlePool(7, 100, T0, at(59), DECL);
    expect(out).toEqual({ value: 7, max: 100, stamp: T0 });
  });

  it("clamps at max", () => {
    const out = settlePool(98, 100, T0, at(600), DECL);
    expect(out.value).toBe(100);
  });

  it("jumps the stamp to now for an already-full pool so it accrues no debt", () => {
    // 605s, deliberately NOT a multiple of the 60s interval: at an exact
    // multiple the interval math alone reproduces `now`, so a test using one
    // (e.g. 600) passes even with the `current >= seeded` branch deleted.
    const out = settlePool(100, 100, T0, at(605), DECL);
    expect(out.value).toBe(100);
    expect(out.stamp).toEqual(at(605));
  });

  it("does not claw back a value above an admin-lowered max", () => {
    const out = settlePool(150, 100, T0, at(600), DECL);
    expect(out.value).toBe(150);
  });

  it("ignores a stamp in the future rather than draining the pool", () => {
    const out = settlePool(20, 100, at(600), T0, DECL);
    expect(out).toEqual({ value: 20, max: 100, stamp: at(600) });
  });

  it("regenerates a percent of max when only regenPercent is set", () => {
    // MCCodes energy: 8% of max per interval, flat amount zero (§7 item 2).
    const decl: AttributePoolDecl = {
      pool: "energy", defaultMax: 25, regenAmount: 0, regenPercent: 8, regenIntervalSeconds: 60,
    };
    // 8% of 25 = 2 per interval; three intervals → 6.
    const out = settlePool(0, 25, T0, at(180), decl);
    expect(out.value).toBe(6);
  });

  it("combines flat and percent (MCCodes brave: 10% + 0.5) and rounds once per batch, not per interval", () => {
    const decl: AttributePoolDecl = {
      pool: "brave", defaultMax: 50, regenAmount: 0.5, regenPercent: 10, regenIntervalSeconds: 300,
    };
    // Per interval: 0.5 + 5 = 5.5. One interval rounds 5.5 → 6; three
    // intervals batch to 16.5 → 17, where per-interval rounding would give 18.
    expect(settlePool(0, 50, T0, at(300), decl).value).toBe(6);
    expect(settlePool(0, 50, T0, at(900), decl).value).toBe(17);
  });

  it("scales the whole per-interval gain by an optional multiplier", () => {
    // Membership/donator regen bonuses arrive as a caller-computed multiplier;
    // MCCodes donators regenerate energy at double the base rate.
    const out = settlePool(0, 100, T0, at(120), DECL, 2);
    expect(out.value).toBe(20);
  });
});
