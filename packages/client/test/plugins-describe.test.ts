import { describe, expect, it } from "vitest";
import { describePluginEvent } from "../src/plugins/describe.js";

describe("describePluginEvent", () => {
  it("expands {placeholder} tokens from the values map", () => {
    expect(describePluginEvent("{actorName} said hello ({count})", {
      actorName: "Ron", count: "3",
    })).toBe("Ron said hello (3)");
  });

  it("leaves an unmatched placeholder literal so a manifest typo is visible", () => {
    expect(describePluginEvent("{actorName} {nope}", { actorName: "Ron" }))
      .toBe("Ron {nope}");
  });

  it("does not re-expand a value that itself contains braces", () => {
    // A player-named target "{target}" must not address other placeholders.
    // `count` must be present in the map for this to discriminate: without it
    // a re-expanding implementation finds no key to substitute on its second
    // pass and the unmatched-placeholder rule hides the bug.
    expect(describePluginEvent("{actorName} -> {target}", {
      actorName: "Ron", count: "3", target: "{count}",
    })).toBe("Ron -> {count}");
  });

  it("stringifies non-string values", () => {
    expect(describePluginEvent("got {n}", { n: 5 })).toBe("got 5");
  });
});
