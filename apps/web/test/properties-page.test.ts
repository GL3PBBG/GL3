import { describe, expect, it } from "vitest";
import { rowAction } from "../src/pages/Properties.js";
import type { PropertyRow } from "@gl3/shared";

function makeRow(overrides: Partial<PropertyRow> = {}): PropertyRow {
  return {
    id: "test-id",
    locationName: "Downtown",
    pluginId: "test-plugin",
    rate: "100",
    ownerName: "—",
    cost: "50000",
    accrued: "0",
    ...overrides,
  };
}

describe("rowAction", () => {
  it("returns buy when the property is unowned", () => {
    const row = makeRow();
    expect(rowAction(row, "alice")).toEqual({ kind: "buy" });
  });

  it("returns owned with accrued when the viewer owns the property (Claim + Sell)", () => {
    const row = makeRow({ ownerName: "alice", accrued: "1200" });
    expect(rowAction(row, "alice")).toEqual({ kind: "owned", accrued: "1200" });
  });

  it("returns none when another player owns the property", () => {
    const row = makeRow({ ownerName: "bob", accrued: "500" });
    expect(rowAction(row, "alice")).toEqual({ kind: "none" });
  });

  it("returns none when viewer is undefined even if ownerName matches", () => {
    const row = makeRow({ ownerName: "alice", accrued: "300" });
    expect(rowAction(row, undefined)).toEqual({ kind: "none" });
  });
});
