import { describe, expect, it } from "vitest";
import { numericEffect } from "../src/lib/effects.js";

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
