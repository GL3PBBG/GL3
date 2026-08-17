import { describe, expect, it } from "vitest";
import { ViewNodeSchema } from "../src/pages.js";

describe("cards view node", () => {
  it("accepts rank+suit codes, jokers and backs", () => {
    const parsed = ViewNodeSchema.parse({ kind: "cards", cards: ["Sq", "H2", "Da", "Ck", "B1", "J1"] });
    expect(parsed).toEqual({ kind: "cards", cards: ["Sq", "H2", "Da", "Ck", "B1", "J1"] });
  });

  it("accepts an empty hand", () => {
    expect(ViewNodeSchema.parse({ kind: "cards", cards: [] })).toEqual({ kind: "cards", cards: [] });
  });

  it("rejects a code that is not a component name", () => {
    // The renderer looks the code up in a map; an unmapped code would render
    // nothing and be silently dropped, which pages.ts's own header calls the
    // failure mode hardest to spot from the page that renders wrong.
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: ["S1"] })).toThrow();
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: ["queen of spades"] })).toThrow();
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: [""] })).toThrow();
  });

  it("nests inside a panel", () => {
    const node = { kind: "panel", title: "Your hand", children: [{ kind: "cards", cards: ["Sq"] }] };
    expect(() => ViewNodeSchema.parse(node)).not.toThrow();
  });
});
