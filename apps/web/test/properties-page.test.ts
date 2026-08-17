import { describe, expect, it } from "vitest";
import { rowAction } from "../src/pages/Properties.js";

const base = {
  id: "p1", locationId: "l1", locationName: "Brooklyn", pluginId: "bullets",
  typeName: "Bullet Factory", price: "100000000", leverLabel: "Price per bullet",
  ownerName: "—", lever: "", profit: "",
};

describe("rowAction", () => {
  it("offers Buy on an unowned, installed type", () => {
    expect(rowAction(base, "vito")).toEqual({ kind: "buy", price: "100000000" });
  });

  it("offers nothing on an unowned type whose plugin is not installed", () => {
    expect(rowAction({ ...base, price: "" }, "vito")).toEqual({ kind: "none" });
  });

  it("offers the owner tools on your own row", () => {
    expect(rowAction({ ...base, ownerName: "vito", lever: "500", profit: "-20" }, "vito"))
      .toEqual({ kind: "owned", lever: "500", profit: "-20", leverLabel: "Price per bullet" });
  });

  it("offers nothing on someone else's row", () => {
    expect(rowAction({ ...base, ownerName: "sonny" }, "vito")).toEqual({ kind: "none" });
  });
});
