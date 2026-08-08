import { describe, expect, it } from "vitest";
import { canAfford, formatAmount, formatMoney, multiplyMoney } from "../src/lib/money.js";

describe("formatAmount", () => {
  it("groups thousands", () => {
    expect(formatAmount("0")).toBe("0");
    expect(formatAmount("999")).toBe("999");
    expect(formatAmount("1000")).toBe("1,000");
    expect(formatAmount("1234567")).toBe("1,234,567");
  });

  it("keeps the sign outside the digits", () => {
    expect(formatAmount("-1234")).toBe("-1,234");
  });

  it("strips leading zeros without eating a lone zero", () => {
    expect(formatAmount("0001234")).toBe("1,234");
    expect(formatAmount("000")).toBe("0");
  });

  /**
   * The whole point of the bigint-string wire format is that values beyond
   * Number.MAX_SAFE_INTEGER survive. A Number-based implementation renders this
   * as 9,007,199,254,740,992 — one too many.
   */
  it("survives past Number.MAX_SAFE_INTEGER", () => {
    expect(formatAmount("9007199254740993")).toBe("9,007,199,254,740,993");
  });

  it("rejects anything that isn't an integer string", () => {
    expect(() => formatAmount("12.5")).toThrow();
    expect(() => formatAmount("")).toThrow();
    expect(() => formatAmount("abc")).toThrow();
  });
});

describe("formatMoney", () => {
  it("prefixes the currency", () => {
    expect(formatMoney("1500")).toBe("$1,500");
  });

  it("puts the minus in front of the currency, not after", () => {
    expect(formatMoney("-1500")).toBe("-$1,500");
  });
});

describe("multiplyMoney", () => {
  it("multiplies without floating point", () => {
    expect(multiplyMoney("250", 4)).toBe("1000");
    expect(multiplyMoney("9007199254740993", 3)).toBe("27021597764222979");
  });

  it("rejects a non-integer count", () => {
    expect(() => multiplyMoney("250", 1.5)).toThrow();
  });
});

describe("canAfford", () => {
  it("compares as bigints, including at the boundary", () => {
    expect(canAfford("100", "100")).toBe(true);
    expect(canAfford("99", "100")).toBe(false);
    expect(canAfford("9007199254740993", "9007199254740992")).toBe(true);
  });
});
