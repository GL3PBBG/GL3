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
});
