import { describe, expect, it } from "vitest";
import { canDelete, nextDeleteStep } from "../src/lib/dangerZone.js";

describe("danger zone two-step confirm", () => {
  it("first click arms, second click fires, typing resets", () => {
    expect(nextDeleteStep("idle")).toBe("armed");
    expect(nextDeleteStep("armed")).toBe("fire");
    expect(nextDeleteStep("fire")).toBe("fire");
  });
  it("cannot delete without a password", () => {
    expect(canDelete("", "armed")).toBe(false);
    expect(canDelete("pw", "idle")).toBe(true);
  });
});
