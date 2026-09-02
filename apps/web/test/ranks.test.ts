import { describe, expect, it } from "vitest";
import type { RankDto } from "@gl3/shared";
import { progressToNextRank, rankForLevel, rankProgress } from "../src/lib/ranks.js";

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

// A routed boot (an `applyExp` claimant, e.g. progression) maps LEVEL onto
// the ladder ordinally — position `min(level, count) - 1` in expRequired
// order, the same rule `syncRankToLevel` stamps `rank_id` with. Within-level
// exp says nothing about rank there, which is what the header got wrong.
describe("rankForLevel", () => {
  it("returns no rank at all when the ladder is empty or the level is 0", () => {
    expect(rankForLevel(3, [])).toEqual({ current: null, next: null, pct: 100 });
    expect(rankForLevel(0, LADDER)).toEqual({ current: null, next: LADDER[1], pct: 0 });
  });

  it("maps level N onto the Nth rung in expRequired order, ignoring exp", () => {
    const one = rankForLevel(1, LADDER);
    expect(one.current?.name).toBe("Nobody");
    expect(one.next?.name).toBe("Thug");
    expect(one.pct).toBe(0);
    expect(rankForLevel(2, LADDER).current?.name).toBe("Thug");
  });

  it("clamps a level past the top of the ladder onto the last rung", () => {
    expect(rankForLevel(40, LADDER)).toEqual({ current: LADDER[2], next: null, pct: 100 });
  });
});

describe("rankProgress", () => {
  it("derives from exp thresholds on an exp boot and from level on a level boot", () => {
    // Level 3 with only 150 exp: the exp model says Thug, the level model says Boss.
    expect(rankProgress("exp", { exp: "150", level: 3 }, LADDER).current?.name).toBe("Thug");
    expect(rankProgress("level", { exp: "150", level: 3 }, LADDER).current?.name).toBe("Boss");
  });

  it("treats an absent model (an older server) as exp", () => {
    expect(rankProgress(undefined, { exp: "150", level: 3 }, LADDER).current?.name).toBe("Thug");
  });
});
