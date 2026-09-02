import { describe, expect, it } from "vitest";
import { LEVEL_SCORE_MULTIPLIER, decodeLevelScore, encodeLevelScore } from "../src/scoring.js";

describe("level score codec", () => {
  it("round-trips level and within-level exp exactly", () => {
    const score = encodeLevelScore(40, 123456789n);
    expect(decodeLevelScore(score.toString())).toEqual({ level: 40, exp: 123456789n });
  });
  it("level dominates: Lv2 with 10 exp beats Lv1 with huge exp", () => {
    expect(encodeLevelScore(2, 10n) > encodeLevelScore(1, 999_999_999_999n)).toBe(true);
  });
  it("level 0 encodes to raw exp — the unrouted-compatible degenerate case", () => {
    expect(encodeLevelScore(0, 42n)).toBe(42n);
    expect(decodeLevelScore("42")).toEqual({ level: 0, exp: 42n });
  });
  it("multiplier is the documented 1e12", () => {
    expect(LEVEL_SCORE_MULTIPLIER).toBe(1_000_000_000_000n);
  });
});
