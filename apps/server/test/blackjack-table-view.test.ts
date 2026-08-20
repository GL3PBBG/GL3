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

/** Every `panel` title in the tree, in tree order. */
function panelTitlesIn(node: ViewNode): string[] {
  if (node.kind === "panel") return [node.title, ...node.children.flatMap(panelTitlesIn)];
  if (node.kind === "list") return node.items.flatMap(panelTitlesIn);
  return [];
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
    const rows = rowsIn(BLACKJACK_TABLE.view(liveTable(), 0)).map((r) => r.value);
    expect(rows).not.toContain("21");
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
    const view = BLACKJACK_TABLE.view(liveTable(), 3);
    const titles = panelTitlesIn(view);
    expect(titles.some((t) => t.includes("Seat 4") && t.includes("you"))).toBe(true);
    expect(titles.some((t) => t.includes("Seat 1") && t.includes("to act"))).toBe(true);
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
