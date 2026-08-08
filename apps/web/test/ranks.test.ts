import { describe, expect, it } from "vitest";
import type { RankDto } from "@gl3/shared";
import { progressToNextRank } from "../src/lib/ranks.js";

function rank(name: string, expRequired: string): RankDto {
  return {
    id: `id-${name}`,
    name,
    expRequired,
    cashReward: "0",
    bulletReward: 0,
    maxHealth: 100,
    current: false,
  };
}

// Deliberately out of order: /api/ranks orders by expRequired today, but the
// derivation must not depend on that.
const LADDER: RankDto[] = [
  rank("Thug", "100"),
  rank("Nobody", "0"),
  rank("Boss", "1000"),
];

describe("progressToNextRank", () => {
  it("returns no rank at all when the ladder is empty", () => {
    expect(progressToNextRank("50", [])).toEqual({ current: null, next: null, pct: 100 });
  });

  it("picks the highest rank the player has earned", () => {
    const result = progressToNextRank("150", LADDER);
    expect(result.current?.name).toBe("Thug");
    expect(result.next?.name).toBe("Boss");
  });

  it("sits at 0% on the exact threshold of the current rank", () => {
    expect(progressToNextRank("100", LADDER).pct).toBe(0);
  });

  it("interpolates between thresholds", () => {
    // 550 of the 100→1000 span is 450/900 = 50%.
    expect(progressToNextRank("550", LADDER).pct).toBe(50);
  });

  it("reports 100% and no next rank at the top", () => {
    const result = progressToNextRank("5000", LADDER);
    expect(result.current?.name).toBe("Boss");
    expect(result.next).toBeNull();
    expect(result.pct).toBe(100);
  });

  it("handles a player below the first rank", () => {
    const above = progressToNextRank("50", [rank("Thug", "100")]);
    expect(above.current).toBeNull();
    expect(above.next?.name).toBe("Thug");
    expect(above.pct).toBe(50);
  });

  it("stays exact past Number.MAX_SAFE_INTEGER", () => {
    // 2^53+1 rounds down to 2^53 as a Number, so float maths reports a player
    // one exp short of the next rank as 100% of the way there.
    const huge = [rank("A", "0"), rank("B", "9007199254740993")];
    expect(progressToNextRank("9007199254740992", huge).pct).toBe(99.99);
  });
});
