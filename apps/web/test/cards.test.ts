import { describe, expect, it } from "vitest";
import { CARD_CODES, cardComponent } from "../src/components/cards.js";

describe("card component map", () => {
  it("resolves every code the SDK schema admits", () => {
    // The two lists must agree: the schema is the authoring-time gate and this
    // map is the render-time one. A code that passes the schema and misses the
    // map renders a blank card, which is the failure hardest to spot.
    for (const code of CARD_CODES) expect(cardComponent(code)).toBeTypeOf("function");
  });

  it("covers 52 cards plus two jokers and two backs", () => {
    expect(CARD_CODES).toHaveLength(56);
  });

  it("returns null for an unknown code rather than throwing", () => {
    // The schema rejects bad codes at authoring time, but a plugin built
    // against an older SDK can still send one. A blank card is recoverable; an
    // exception unmounts the React root, because there is no ErrorBoundary
    // (pages.ts says so of the money leaf, for the same reason).
    expect(cardComponent("ZZ")).toBeNull();
    expect(cardComponent("")).toBeNull();
  });

  it("agrees with the SDK's own regex", async () => {
    const { ViewNodeSchema } = await import("@gl3/plugin-sdk");
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: [...CARD_CODES] })).not.toThrow();
  });
});
