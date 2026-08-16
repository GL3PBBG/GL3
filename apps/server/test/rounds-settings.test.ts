import { describe, expect, it } from "vitest";
import { payoutPoints } from "../src/game/rounds/settings.js";

const DEFAULT = [1000n, 500n, 250n];

describe("payoutPoints", () => {
  it("falls back to the default when the key is missing", () => {
    expect(payoutPoints({})).toEqual(DEFAULT);
  });

  it("falls back when the value is blank or whitespace", () => {
    expect(payoutPoints({ "rounds.payout_points": "" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "   " })).toEqual(DEFAULT);
  });

  it("falls back on unparseable JSON", () => {
    expect(payoutPoints({ "rounds.payout_points": "[1000, 500" })).toEqual(DEFAULT);
  });

  it("falls back when the JSON is not an array", () => {
    expect(payoutPoints({ "rounds.payout_points": '{"first":1000}' })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "1000" })).toEqual(DEFAULT);
  });

  it("accepts number elements", () => {
    expect(payoutPoints({ "rounds.payout_points": "[5000, 2500]" })).toEqual([5000n, 2500n]);
  });

  it("accepts digit-string elements", () => {
    expect(payoutPoints({ "rounds.payout_points": '["5000","2500"]' })).toEqual([5000n, 2500n]);
  });

  it("accepts zero awards", () => {
    expect(payoutPoints({ "rounds.payout_points": "[0, 0]" })).toEqual([0n, 0n]);
  });

  it("rejects the whole array when any element is bad", () => {
    expect(payoutPoints({ "rounds.payout_points": "[1000, -5]" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "[1000, 1.5]" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": '[1000, "5x"]' })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "[1000, null]" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "[1000, 1e30]" })).toEqual(DEFAULT);
  });

  it("returns an empty award table for [] rather than falling back", () => {
    expect(payoutPoints({ "rounds.payout_points": "[]" })).toEqual([]);
  });

  it("truncates to 100 places", () => {
    const many = JSON.stringify(Array.from({ length: 150 }, (_, i) => i + 1));
    const parsed = payoutPoints({ "rounds.payout_points": many });
    expect(parsed).toHaveLength(100);
    expect(parsed[99]).toBe(100n);
  });
});
