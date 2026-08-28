import { describe, expect, it } from "vitest";
import { ownedProperties } from "../src/pages/Stats.js";
import type { PropertyRow } from "@gl3/shared";

function makeRow(overrides: Partial<PropertyRow> = {}): PropertyRow {
  return {
    id: "p1", locationId: "l1", locationName: "Brooklyn", pluginId: "bullets",
    typeName: "Bullet Factory", price: "100000000", leverLabel: "Price per bullet",
    ownerName: "—", lever: "", profit: "", imageUrl: "",
    ...overrides,
  };
}

describe("ownedProperties", () => {
  it("keeps only the rows the player owns", () => {
    const rows = [
      makeRow({ id: "p1", ownerName: "vito", lever: "500", profit: "1200" }),
      makeRow({ id: "p2", ownerName: "sonny" }),
      makeRow({ id: "p3" }),
    ];
    expect(ownedProperties(rows, "vito").map((r) => r.id)).toEqual(["p1"]);
  });

  it("answers empty when the player owns nothing", () => {
    expect(ownedProperties([makeRow({ ownerName: "sonny" })], "vito")).toEqual([]);
  });

  it("never matches the unowned placeholder against an odd username", () => {
    // "—" is the server's no-owner marker, not a name.
    expect(ownedProperties([makeRow({ ownerName: "—" })], "—")).toEqual([]);
  });
});
