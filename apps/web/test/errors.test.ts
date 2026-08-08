import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.js";
import { describeError, formatDuration } from "../src/lib/errors.js";

describe("formatDuration", () => {
  it("renders sub-minute waits in seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("pads the seconds in minute form", () => {
    expect(formatDuration(60)).toBe("1m 00s");
    expect(formatDuration(125)).toBe("2m 05s");
  });

  it("clamps a negative wait rather than rendering '-3s'", () => {
    expect(formatDuration(-3)).toBe("0s");
  });
});

describe("describeError", () => {
  it("turns a code into a sentence", () => {
    expect(describeError(new ApiError(401, "invalid_credentials"))).toBe(
      "Wrong username or password.",
    );
  });

  it("falls back to the raw code so a new server code stays diagnosable", () => {
    expect(describeError(new ApiError(400, "brand_new_code"))).toBe("brand_new_code");
  });

  it("uses the server's numbers on the timed codes", () => {
    expect(describeError(new ApiError(423, "jailed", { remainingSeconds: 90 }))).toBe(
      "You're in jail for another 1m 30s.",
    );
    expect(describeError(new ApiError(429, "on_cooldown", { retryAfter: 12 }))).toBe(
      "Not ready yet — 12s to go.",
    );
    expect(describeError(new ApiError(409, "insufficient_stock", { available: 3 }))).toBe(
      "Only 3 bullets left here.",
    );
  });

  it("falls back to the plain sentence when the number is missing", () => {
    expect(describeError(new ApiError(423, "jailed"))).toBe("You're in jail.");
    expect(describeError(new ApiError(429, "on_cooldown"))).toBe("Not ready yet.");
  });

  it("handles non-ApiError values", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("boom")).toBe("Something went wrong.");
    expect(describeError(null)).toBe("Something went wrong.");
  });
});
