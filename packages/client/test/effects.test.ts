import { describe, expect, it } from "vitest";
import { numericEffect, shotsToKill, stringEffect, weaponStatLine } from "../src/lib/effects.js";

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

describe("stringEffect", () => {
  it("reads a consumable's effect kind", () => {
    expect(stringEffect({ kind: "tonic" }, "kind")).toBe("tonic");
  });

  it("reads an absent or empty kind as null, the way the server reads it as heal", () => {
    // The server treats absent and "" identically (both select the built-in
    // heal def), so the page must not show either as a kind of its own.
    expect(stringEffect({ heal: 20 }, "kind")).toBeNull();
    expect(stringEffect({ kind: "" }, "kind")).toBeNull();
  });

  it("returns null for a non-string value rather than coercing it", () => {
    expect(stringEffect({ kind: 7 }, "kind")).toBeNull();
    expect(stringEffect(null, "kind")).toBeNull();
    expect(stringEffect("nope", "kind")).toBeNull();
  });
});

/**
 * The one weapon line both `/inventory` and `/shop` render. It lives here
 * rather than in either page because neither project has a DOM environment to
 * render a component in — a shared pure function is the only part of the two
 * stat lines a test can reach at all.
 */
describe("weaponStatLine", () => {
  it("reads the damage range and appends shots to kill", () => {
    // avg 15, no crit -> ceil(100 / 15) = 7
    expect(weaponStatLine({ damageMin: 10, damageMax: 20 }))
      .toBe("10–20 damage · ~7 shots to kill");
  });

  it("appends the dps that paces the weapon's cooldown", () => {
    expect(weaponStatLine({ damageMin: 10, damageMax: 20, dps: 2 }))
      .toBe("10–20 damage · 2 dps · ~7 shots to kill");
  });

  it("keeps a fractional dps as written", () => {
    // 0.5 is the value a half-rate weapon needs; rounding it to 0 or 1 here
    // would misreport a 20-second cooldown as instant or as 10 seconds.
    expect(weaponStatLine({ damageMin: 10, damageMax: 10, dps: 0.5 }))
      .toBe("10–10 damage · 0.5 dps · ~10 shots to kill");
  });

  it("omits the dps clause entirely when the weapon declares none", () => {
    // Absent means the flat combat.cooldown_seconds, which this page has no
    // way to know — so it says nothing rather than inventing a number.
    expect(weaponStatLine({ damageMin: 4, damageMax: 6, dps: 0 }))
      .toBe("4–6 damage · ~20 shots to kill");
    expect(weaponStatLine({ damageMin: 4, damageMax: 6, dps: "fast" }))
      .toBe("4–6 damage · ~20 shots to kill");
  });

  it("shows the bullet count when a shot spends more than one bullet", () => {
    // avg 15 -> 7 shots x 3 bullets = 21
    expect(weaponStatLine({ damageMin: 10, damageMax: 20, bulletsPerShot: 3 }))
      .toBe("10–20 damage · ~7 shots to kill (21 bullets)");
  });

  it("omits the bullet count when a shot spends exactly one bullet", () => {
    expect(weaponStatLine({ damageMin: 10, damageMax: 20, bulletsPerShot: 1 }))
      .toBe("10–20 damage · ~7 shots to kill");
  });

  it("omits the shots clause for a weapon that cannot deal damage", () => {
    expect(weaponStatLine({ damageMin: 0, damageMax: 0 })).toBe("0–0 damage");
  });

  it("returns null for a weapon whose damage range is unusable", () => {
    // Each page renders its own fallback for this — "unusable" on /inventory,
    // nothing at all on /shop — so the helper reports the fact, not the copy.
    expect(weaponStatLine({ damageMin: 4 })).toBeNull();
    expect(weaponStatLine(null)).toBeNull();
    expect(weaponStatLine({})).toBeNull();
  });
});

/**
 * Estimated shots to drop a 100-health unarmored target — 100 matches
 * `ranks.max_health`'s default. Accuracy is deliberately ignored: a migrated
 * V2 weapon carries none and the server-side default is invisible here, so
 * factoring it in only when present would make two rows non-comparable.
 */
describe("shotsToKill", () => {
  it("divides baseline health by the average damage", () => {
    expect(shotsToKill({ damageMin: 10, damageMax: 20 }))
      .toEqual({ shots: 7, bullets: 7 });
  });

  it("rounds shots up — a target on 1 health still takes a shot", () => {
    // avg 30 -> 100/30 = 3.33 -> 4
    expect(shotsToKill({ damageMin: 30, damageMax: 30 }))
      .toEqual({ shots: 4, bullets: 4 });
  });

  it("folds the crit chance and multiplier into the expected damage", () => {
    // 10 x (1 + 0.5 x (2 - 1)) = 15 -> ceil(100/15) = 7
    expect(shotsToKill({ damageMin: 10, damageMax: 10, critChance: 50, critMultiplier: 2 }))
      .toEqual({ shots: 7, bullets: 7 });
  });

  it("multiplies bullets by bulletsPerShot", () => {
    expect(shotsToKill({ damageMin: 10, damageMax: 20, bulletsPerShot: 3 }))
      .toEqual({ shots: 7, bullets: 21 });
  });

  it("ignores a non-positive or non-numeric bulletsPerShot", () => {
    expect(shotsToKill({ damageMin: 10, damageMax: 20, bulletsPerShot: 0 }))
      .toEqual({ shots: 7, bullets: 7 });
    expect(shotsToKill({ damageMin: 10, damageMax: 20, bulletsPerShot: "3" }))
      .toEqual({ shots: 7, bullets: 7 });
  });

  it("returns null when the damage range is unusable or cannot kill", () => {
    expect(shotsToKill({ damageMax: 20 })).toBeNull();
    expect(shotsToKill({ damageMin: 0, damageMax: 0 })).toBeNull();
    expect(shotsToKill(null)).toBeNull();
  });
});
