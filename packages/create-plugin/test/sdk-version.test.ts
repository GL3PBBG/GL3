import { describe, expect, it } from "vitest";
import { BAKED_SDK_RANGE, rangeFromVersion, resolveSdkRange } from "../src/sdk-version.js";

describe("rangeFromVersion", () => {
  it("turns a semver into a caret range", () => {
    expect(rangeFromVersion("1.0.6")).toBe("^1.0.6");
    expect(rangeFromVersion("1.0.6\n")).toBe("^1.0.6"); // npm view prints a trailing newline
  });

  it("rejects anything that is not x.y.z", () => {
    expect(rangeFromVersion("")).toBeNull();
    expect(rangeFromVersion("1.0")).toBeNull();
    expect(rangeFromVersion("latest")).toBeNull();
    expect(rangeFromVersion("npm ERR! 404")).toBeNull();
  });
});

describe("resolveSdkRange", () => {
  it("prefers an explicit override verbatim", () => {
    expect(resolveSdkRange({ override: "^9.9.9", lookup: () => "1.0.6" })).toBe("^9.9.9");
  });

  it("uses the registry lookup when there is no override", () => {
    expect(resolveSdkRange({ lookup: () => "1.2.3" })).toBe("^1.2.3");
  });

  it("falls back to the baked range and warns when the lookup fails", () => {
    const warnings: string[] = [];
    expect(resolveSdkRange({ lookup: () => null, warn: (m) => warnings.push(m) })).toBe(BAKED_SDK_RANGE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(BAKED_SDK_RANGE);
    expect(warnings[0]).toContain("--sdk");
  });

  it("falls back when the lookup returns garbage", () => {
    expect(resolveSdkRange({ lookup: () => "npm ERR! 404", warn: () => {} })).toBe(BAKED_SDK_RANGE);
  });
});
