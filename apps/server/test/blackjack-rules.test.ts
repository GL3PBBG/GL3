import { describe, expect, it } from "vitest";
import { handValue, shuffle } from "@gl3/plugin-blackjack";

describe("hand value", () => {
  it("counts an ace as 11 when it fits and 1 when it does not", () => {
    expect(handValue(["Sa", "Sk"])).toBe(21);
    expect(handValue(["Sa", "Sk", "H5"])).toBe(16);
    expect(handValue(["Sa", "Sa"])).toBe(12);
  });

  it("counts faces as ten", () => {
    expect(handValue(["Sj", "Hq", "Dk"])).toBe(30);
  });
});

describe("shoe", () => {
  it("is deterministic in the seed", () => {
    expect(shuffle("seed-a")).toEqual(shuffle("seed-a"));
    expect(shuffle("seed-a")).not.toEqual(shuffle("seed-b"));
  });

  it("is six full decks", () => {
    const shoe = shuffle("seed-a");
    expect(shoe).toHaveLength(312);
    expect(shoe.filter((c) => c === "Sa")).toHaveLength(6);
  });
});
