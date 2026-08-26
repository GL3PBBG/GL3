import { describe, expect, it } from "vitest";
import { settleHealth } from "../src/game/health-settle.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("settleHealth (pure, ⅓ of max per 5 minutes)", () => {
  it("is identity when max is unset — rank-derived GL3-native health", () => {
    expect(settleHealth(10, 0, T0, at(9999))).toEqual({ health: 10, max: 0, stamp: T0 });
    expect(settleHealth(10, -1, T0, at(9999))).toEqual({ health: 10, max: -1, stamp: T0 });
  });

  it("starts the clock on a null stamp without accruing", () => {
    const out = settleHealth(10, 60, null, at(600));
    expect(out).toEqual({ health: 10, max: 60, stamp: at(600) });
  });

  it("regenerates a third of max per interval, whole intervals only", () => {
    // 60 max → 20/interval; 600s = 2 intervals → 10 + 40 = 50.
    const out = settleHealth(10, 60, T0, at(600));
    expect(out.health).toBe(50);
    expect(out.stamp).toEqual(at(600));
    // The remainder survives: 650s is still 2 intervals.
    expect(settleHealth(10, 60, T0, at(650)).stamp).toEqual(at(600));
  });

  it("rounds once per batch, not per interval", () => {
    // 55 max → 55/3 = 18.33/interval. One interval rounds to 18; three
    // intervals batch to round(55) = 55 — where per-interval rounding would
    // cap at 54.
    expect(settleHealth(0, 55, T0, at(300)).health).toBe(18);
    expect(settleHealth(0, 55, T0, at(900)).health).toBe(55);
  });

  it("clamps at max and jumps the stamp for an already-full pool", () => {
    const full = settleHealth(60, 60, T0, at(605));
    expect(full).toEqual({ health: 60, max: 60, stamp: at(605) });
  });
});
