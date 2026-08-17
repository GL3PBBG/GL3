import { describe, expect, it } from "vitest";
import { numericEffect, weaponStatLine } from "../src/lib/effects.js";

describe("numericEffect", () => {
  it("reads a numeric field out of an unknown effects blob", () => {
    expect(numericEffect({ damageMin: 8, damageMax: 18 }, "damageMin")).toBe(8);
  });

  it("returns null for a missing field", () => {
    expect(numericEffect({ damageMin: 8 }, "armor")).toBeNull();
  });

  it("returns null for a non-numeric value rather than coercing it", () => {
    expect(numericEffect({ armor: "12" }, "armor")).toBeNull();
  });

  it("returns null for null, undefined and non-objects", () => {
    expect(numericEffect(null, "armor")).toBeNull();
    expect(numericEffect(undefined, "armor")).toBeNull();
    expect(numericEffect(42, "armor")).toBeNull();
    expect(numericEffect("nope", "armor")).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(numericEffect({ armor: Number.NaN }, "armor")).toBeNull();
  });
});

/**
 * The one weapon line both `/inventory` and `/shop` render. It lives here
 * rather than in either page because neither project has a DOM environment to
 * render a component in — a shared pure function is the only part of the two
 * stat lines a test can reach at all.
 */
describe("weaponStatLine", () => {
  it("reads the damage range", () => {
    expect(weaponStatLine({ damageMin: 10, damageMax: 20 })).toBe("10–20 damage");
  });

  it("appends the dps that paces the weapon's cooldown", () => {
    expect(weaponStatLine({ damageMin: 10, damageMax: 20, dps: 2 }))
      .toBe("10–20 damage · 2 dps");
  });

  it("keeps a fractional dps as written", () => {
    // 0.5 is the value a half-rate weapon needs; rounding it to 0 or 1 here
    // would misreport a 20-second cooldown as instant or as 10 seconds.
    expect(weaponStatLine({ damageMin: 10, damageMax: 10, dps: 0.5 }))
      .toBe("10–10 damage · 0.5 dps");
  });

  it("omits the dps clause entirely when the weapon declares none", () => {
    // Absent means the flat combat.cooldown_seconds, which this page has no
    // way to know — so it says nothing rather than inventing a number.
    expect(weaponStatLine({ damageMin: 4, damageMax: 6, dps: 0 })).toBe("4–6 damage");
    expect(weaponStatLine({ damageMin: 4, damageMax: 6, dps: "fast" })).toBe("4–6 damage");
  });

  it("returns null for a weapon whose damage range is unusable", () => {
    // Each page renders its own fallback for this — "unusable" on /inventory,
    // nothing at all on /shop — so the helper reports the fact, not the copy.
    expect(weaponStatLine({ damageMin: 4 })).toBeNull();
    expect(weaponStatLine(null)).toBeNull();
    expect(weaponStatLine({})).toBeNull();
  });
});
