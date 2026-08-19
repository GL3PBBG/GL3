import { describe, expect, it } from "vitest";
import { dropRefundOf, rowAction, rowsFor } from "../src/components/PropertyPanel.js";

const base = {
  id: "p1", locationId: "l1", locationName: "Brooklyn", pluginId: "bullets",
  typeName: "Bullet Factory", price: "100000000", leverLabel: "Price per bullet",
  ownerName: "—", lever: "", profit: "",
};

describe("rowsFor", () => {
  it("keeps only the rows declared by the given plugin", () => {
    const rows = [base, { ...base, id: "p2", pluginId: "blackjack", typeName: "Blackjack Table" }];
    expect(rowsFor(rows, "blackjack").map((r) => r.id)).toEqual(["p2"]);
  });

  it("answers empty when the plugin declares nothing here", () => {
    expect(rowsFor([base], "casino")).toEqual([]);
  });
});

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

describe("dropRefundOf", () => {
  it("halves the declared price, flooring the odd cent", () => {
    expect(dropRefundOf("100000000")).toBe("50000000");
    expect(dropRefundOf("101")).toBe("50");
  });

  it("answers 0 for a type whose plugin is not installed (no declared price)", () => {
    expect(dropRefundOf("")).toBe("0");
  });
});
