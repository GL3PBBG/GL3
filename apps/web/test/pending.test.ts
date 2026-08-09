import { describe, expect, it } from "vitest";
import { togglePending } from "../src/plugins/pending.js";

describe("togglePending", () => {
  it("adds an index when marked active", () => {
    expect(togglePending(new Set(), 3, true)).toEqual(new Set([3]));
  });

  it("removes an index when marked inactive", () => {
    expect(togglePending(new Set([3, 5]), 3, false)).toEqual(new Set([5]));
  });

  it("leaves other indices untouched, so one action in flight does not disable another", () => {
    const pending = togglePending(new Set([1]), 2, true);
    expect(pending.has(1)).toBe(true);
    expect(pending.has(2)).toBe(true);
  });

  it("does not mutate the set it was given", () => {
    const original = new Set([1]);
    togglePending(original, 2, true);
    expect(original).toEqual(new Set([1]));
  });

  it("is a no-op removing an index that was never pending", () => {
    expect(togglePending(new Set([1]), 9, false)).toEqual(new Set([1]));
  });
});
