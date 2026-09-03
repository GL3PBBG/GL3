import { describe, expect, it } from "vitest";
import { encodeLevelScore } from "@gl3/shared";
import { formatBoardScore } from "../src/lib/level-score-display.js";

describe("formatBoardScore", () => {
  it("decodes a level-mode exp score into 'Lv {level} · {exp} exp'", () => {
    const score = encodeLevelScore(40, 123n).toString();
    expect(formatBoardScore("exp", "level", score)).toBe("Lv 40 · 123 exp");
  });

  it("comma-formats the within-level exp component", () => {
    const score = encodeLevelScore(2, 12_345n).toString();
    expect(formatBoardScore("exp", "level", score)).toBe("Lv 2 · 12,345 exp");
  });

  it("passes the raw score through unchanged when mode is absent", () => {
    expect(formatBoardScore("exp", undefined, "999")).toBe("999");
  });

  it("passes the raw score through unchanged when mode is 'exp'", () => {
    expect(formatBoardScore("exp", "exp", "999")).toBe("999");
  });

  it("passes cash/bank scores through unchanged regardless of mode", () => {
    // cash/bank never carry mode: "level" in practice, but the helper itself
    // must not decode a non-exp kind even if it somehow did.
    expect(formatBoardScore("cash", "level", "500")).toBe("500");
  });

  it("decodes level 0 (an unrouted-looking composite) correctly", () => {
    const score = encodeLevelScore(0, 7n).toString();
    expect(formatBoardScore("exp", "level", score)).toBe("Lv 0 · 7 exp");
  });
});
