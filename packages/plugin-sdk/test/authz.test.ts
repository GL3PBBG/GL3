import { describe, expect, it } from "vitest";
import { hasPermission } from "../src/authz.js";

describe("hasPermission", () => {
  it("denies with no grants", () => {
    expect(hasPermission([], "news")).toBe(false);
  });

  it("denies when grants name a different module", () => {
    expect(hasPermission(["mail"], "news")).toBe(false);
  });

  it("allows an exact module grant", () => {
    expect(hasPermission(["news"], "news")).toBe(true);
  });

  it("allows the * wildcard for any module", () => {
    expect(hasPermission(["*"], "news")).toBe(true);
    expect(hasPermission(["*"], "travel")).toBe(true);
  });

  it("does not treat * as a prefix pattern", () => {
    // "news*" or "n*" must NOT match — only the literal wildcard row does.
    expect(hasPermission(["news*"], "news")).toBe(false);
  });
});
