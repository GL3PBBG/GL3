import { describe, expect, it } from "vitest";
import type { ViewNode } from "@gl3/plugin-sdk";
import { BLACKJACK_TABLE, shuffle, type BjTableState } from "@gl3/plugin-blackjack";

/**
 * What a player can SEE, as opposed to what the hand contains — the table
 * version of `blackjack-view.test.ts`'s contract. Nothing asserted view
 * CONTENT at all before that file, which is how the dealer's hole card
 * shipped face-up through eleven task reviews; this file exists so the same
 * gap cannot reopen once a hand is shared across a table of seats.
 *
 * Everything here goes through `TableGameDef`'s own surface (`deal`, `act`,
 * `autoAct`, `view`, `settle`), because that is exactly what the hub calls
 * and hands to the page.
 */

const W = 100_000n;

/** Every card code the view puts on screen, in tree order. */
function cardsIn(node: ViewNode): string[] {
  if (node.kind === "cards") return [...node.cards];
  if (node.kind === "panel") return node.children.flatMap(cardsIn);
  if (node.kind === "list") return node.items.flatMap(cardsIn);
  return [];
}

/** Every `cards` node in the tree, in tree order — hand contents plus how it is drawn. */
function handsIn(node: ViewNode): { cards: string[]; size?: "sm" | "md" | "lg"; caption?: string }[] {
  if (node.kind === "cards") {
    return [{ cards: [...node.cards], ...(node.size === undefined ? {} : { size: node.size }),
      ...(node.caption === undefined ? {} : { caption: node.caption }) }];
  }
  if (node.kind === "panel") return node.children.flatMap(handsIn);
  if (node.kind === "list") return node.items.flatMap(handsIn);
  return [];
}

/**
 * Every string the view puts a NAME in — panel titles and hand captions both.
 *
 * The two are one vocabulary on purpose: a seat's identity moved from a panel
 * title to a `cards` caption when the seats became a row, and "the viewer's own
 * seat is marked" is the same contract wherever the mark is drawn.
 */
function labelsIn(node: ViewNode): string[] {
  if (node.kind === "cards") return node.caption === undefined ? [] : [node.caption];
  if (node.kind === "panel") return [node.title, ...node.children.flatMap(labelsIn)];
  if (node.kind === "list") return node.items.flatMap(labelsIn);
  return [];
}

/** Every `keyValue` row the view puts on screen, in tree order. */
function rowsIn(node: ViewNode): { label: string; value: string }[] {
  if (node.kind === "keyValue") return node.rows.map((r) => ({ label: r.label, value: r.value }));
  if (node.kind === "panel") return node.children.flatMap(rowsIn);
  if (node.kind === "list") return node.items.flatMap(rowsIn);
  return [];
}

function valueOf(node: ViewNode, label: string): string | undefined {
  return rowsIn(node).find((row) => row.label === label)?.value;
}

function liveTable(): BjTableState {
  return {
    shoe: shuffle("fixture"), cursor: 6,
    hands: [
      { seat: 0, cards: ["S9", "S8"], wager: W, phase: "playing" },
      { seat: 3, cards: ["C4", "C9"], wager: W, phase: "playing" },
    ],
    dealer: ["Hk", "Da"],   // up-card Hk, hole Da — 21 if seen
    turn: 0, done: false,
  };
}

/** A table with `count` seats taken, seat 0 first — for the shrink-as-it-fills rule. */
function tableOf(count: number): BjTableState {
  return {
    ...liveTable(),
    hands: Array.from({ length: count }, (_, seat) => ({
      seat, cards: ["S9", "S8"] as string[], wager: W, phase: "playing" as const,
    })),
  };
}

describe("the dealer's hole card at a table", () => {
  it("is face-down for every viewer while any seat is still choosing", () => {
    for (const viewer of [0, 3, null]) {
      const cards = cardsIn(BLACKJACK_TABLE.view(liveTable(), viewer));
      expect(cards).toContain("Hk");
      expect(cards).not.toContain("Da");
      expect(cards.filter((c) => c === "B1" || c === "B2")).toHaveLength(1);
    }
  });

  it("does not leak through the dealer total", () => {
    const view = BLACKJACK_TABLE.view(liveTable(), 0);
    expect(rowsIn(view).map((r) => r.value)).not.toContain("21");
    // Captions carry a seat's total now, so they are a second channel the same
    // figure could escape through.
    expect(labelsIn(view).join(" ")).not.toContain("21");
  });

  it("every seat's own cards are public to every viewer — blackjack hides only the hole card", () => {
    const cards = cardsIn(BLACKJACK_TABLE.view(liveTable(), 3));
    expect(cards).toEqual(expect.arrayContaining(["S9", "S8", "C4", "C9"]));
  });

  it("reveals dealer hand and true total once done", () => {
    const done: BjTableState = { ...liveTable(), done: true, turn: null };
    const view = BLACKJACK_TABLE.view(done, 0);
    expect(cardsIn(view)).toContain("Da");
    expect(cardsIn(view).filter((c) => c === "B1" || c === "B2")).toHaveLength(0);
    expect(valueOf(view, "Dealer total")).toBe("21");
  });

  it("marks the viewer's own seat and the seat whose turn it is", () => {
    // Both marks survived the move to a dealer/others-row/own-hand layout —
    // the viewer's on its own panel's title, another seat's on that hand's
    // caption, since a row of hands has no titles to carry it.
    const labels = labelsIn(BLACKJACK_TABLE.view(liveTable(), 3));
    expect(labels.some((l) => l.includes("Seat 4") && l.includes("your hand"))).toBe(true);
    expect(labels.some((l) => l.includes("Seat 1") && l.includes("to act"))).toBe(true);
  });
});

/**
 * The layout the UAT asked for: dealer on top, the other seats side by side in
 * one row under it, the viewer's own hand below and biggest. Asserted on the
 * TREE rather than on rendered HTML because the tree is what blackjack owns —
 * the renderer turns a `layout: "row"` panel into a flex row and a `size` into
 * a `--card-w`, and both are tested where they live.
 */
describe("the shape of a shared table", () => {
  it("puts the dealer first, the other seats in one row, and the viewer's hand last", () => {
    const view = BLACKJACK_TABLE.view(liveTable(), 3);
    expect(view.kind).toBe("list");
    const panels = view.kind === "list" ? view.items : [];
    expect(panels.map((p) => (p.kind === "panel" ? p.title : p.kind)))
      .toEqual(["Dealer", "The other seat", "Seat 4 — your hand"]);

    // ONE panel holding every other seat, laid out horizontally: a panel per
    // seat is what stacked them down the page in the first place.
    const others = panels[1];
    if (others === undefined || others.kind !== "panel") throw new Error("no seats panel");
    expect(others.layout).toBe("row");
    expect(others.children.map((child) => child.kind)).toEqual(["cards"]);
  });

  it("draws the viewer's own hand large and captions only the others", () => {
    const hands = handsIn(BLACKJACK_TABLE.view(liveTable(), 3));
    // dealer, seat 0 (the other seat), seat 3 (mine)
    expect(hands.map((h) => h.size)).toEqual(["lg", "md", "lg"]);
    expect(hands[1]?.caption).toContain("Seat 1");
    // The viewer's own hand is titled by its panel, so a caption would say it twice.
    expect(hands[2]?.caption).toBeUndefined();
  });

  it("shrinks the other seats' hands once three or more of them are in the row", () => {
    // Four hands, viewer at seat 0 → three others. Four opponents at `sm` are
    // 740px against an 803px content column; at `md` they would be 1208px.
    // Drop the dealer's hand (first) and the viewer's own (last).
    const others = (count: number): (string | undefined)[] =>
      handsIn(BLACKJACK_TABLE.view(tableOf(count), 0)).slice(1, -1).map((h) => h.size);
    expect(others(3)).toEqual(["md", "md"]);
    expect(others(4)).toEqual(["sm", "sm", "sm"]);
    expect(others(5)).toEqual(["sm", "sm", "sm", "sm"]);
  });

  /**
   * A table's view is built per request and validated by NOTHING on the way
   * out — `guardGame` calls `view` and the hub returns the node raw, so the
   * only parse it faces is `CasinoTableResponseSchema` in the BROWSER. That
   * parse is all-or-nothing: a prop `@gl3/shared` lacks takes down the whole
   * table payload for every seat, which is the `cards`-leaf failure this repo
   * already shipped once. The parity test guards the two vocabularies against
   * each other; this guards the node blackjack actually emits.
   */
  it("parses against the WIRE schema, not just the SDK's", async () => {
    const { BoundedViewNodeDtoSchema } = await import("@gl3/shared");
    for (const viewer of [0, 3, null]) {
      expect(BoundedViewNodeDtoSchema.safeParse(BLACKJACK_TABLE.view(liveTable(), viewer)).success)
        .toBe(true);
    }
    expect(BoundedViewNodeDtoSchema.safeParse(BLACKJACK_TABLE.view(tableOf(5), 0)).success).toBe(true);
  });

  it("gives a spectator the whole table as one row and no hand of their own", () => {
    const view = BLACKJACK_TABLE.view(liveTable(), null);
    const panels = view.kind === "list" ? view.items : [];
    expect(panels.map((p) => (p.kind === "panel" ? p.title : p.kind)))
      .toEqual(["Dealer", "The other seats"]);
  });
});

describe("GameDef plumbing", () => {
  it("deal/act/autoAct/settle round-trip through the TableGameDef surface", () => {
    const step = BLACKJACK_TABLE.deal({ seats: [{ seat: 0, wager: W }], seed: "no-natural" });
    expect(step.done).toBe(false);
    expect(step.turn).toBe(0);
    const done = BLACKJACK_TABLE.autoAct(step.state, 0);   // stand
    expect(done.done).toBe(true);
    const payouts = BLACKJACK_TABLE.settle(done.state);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.seat).toBe(0);
  });

  it("rejects actions outside the schema", () => {
    expect(BLACKJACK_TABLE.action.safeParse("split").success).toBe(false);
    expect(BLACKJACK_TABLE.action.safeParse("hit").success).toBe(true);
  });
});
