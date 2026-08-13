import { describe, expect, it } from "vitest";
import { unixToDate } from "../src/time.js";

describe("unixToDate", () => {
  it("converts a unix-epoch second count to a Date", () => {
    expect(unixToDate(1_700_000_000)).toEqual(new Date(1_700_000_000_000));
  });

  it("passes through null and undefined as null", () => {
    expect(unixToDate(null)).toBeNull();
    expect(unixToDate(undefined)).toBeNull();
  });
});
