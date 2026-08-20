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

/** Every `text` leaf in the tree, in tree order. */
function textsIn(node: ViewNode): string[] {
  if (node.kind === "text") return [node.value];
  if (node.kind === "panel") return node.children.flatMap(textsIn);
  if (node.kind === "list") return node.items.flatMap(textsIn);
  return [];
}

/** Every `money` leaf in the tree, in tree order — raw wire values, not formatted. */
function moneysIn(node: ViewNode): string[] {
  if (node.kind === "money") return [node.value];
  if (node.kind === "panel") return node.children.flatMap(moneysIn);
  if (node.kind === "list") return node.items.flatMap(moneysIn);
  return [];
}

/** The first panel whose title contains `contains` — the viewer's own hand panel. */
function panelTitled(node: ViewNode, contains: string): ViewNode | undefined {
  if (node.kind === "panel") {
    if (node.title.includes(contains)) return node;
    for (const child of node.children) {
      const hit = panelTitled(child, contains);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node.kind === "list") {
    for (const item of node.items) {
      const hit = panelTitled(item, contains);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function ownPanel(view: ViewNode): ViewNode {
  const panel = panelTitled(view, "your hand");
  if (panel === undefined) throw new Error("no own-hand panel");
  return panel;
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

/**
 * A finished hand against a dealer 19, one seat per outcome the payout table
 * can produce a distinct figure for: seat 0 a natural (2.5x back, net +1.5x),
 * seat 1 a push at 19 (stake back, net 0), seat 2 bust (nothing back, net -1x).
 * The fourth outcome — a live hand that simply loses — is seat 3 in the tests
 * that need it, since a bust and a loss pay identically but read differently.
 */
function settledTable(): BjTableState {
  return {
    shoe: shuffle("fixture"), cursor: 12,
    hands: [
      { seat: 0, cards: ["Sk", "Sa"], wager: W, phase: "natural" },
      { seat: 1, cards: ["C9", "Ck"], wager: W, phase: "stood" },
      { seat: 2, cards: ["H8", "H9", "H7"], wager: W, phase: "bust" },
    ],
    dealer: ["Hk", "S9"],   // 19, and no natural to void seat 0's
    turn: null, done: true,
  };
}

/** The same hand with a fourth seat that stood on 18 and was simply out-drawn. */
function settledWithLoser(): BjTableState {
  const base = settledTable();
  return {
    ...base,
    hands: [...base.hands, { seat: 3, cards: ["D8", "Dk"], wager: W, phase: "stood" }],
  };
}

/**
 * The victory moment. A settled table retains its final state and keeps
 * rendering it through the betting phase, so the reveal is the only place a
 * player learns what the hand paid — before this, the cards were on screen and
 * the money was not, and everyone had to infer the result from their cash.
 *
 * Figures are NET throughout: a seat that staked 100,000 and got 200,000 back
 * "wins +100,000", never "won 200,000", which reads as double what it is.
 */
describe("what a settled hand pays", () => {
  it("captions every other seat with its own outcome and net figure", () => {
    const labels = labelsIn(BLACKJACK_TABLE.view(settledTable(), null)).join(" | ");
    expect(labels).toContain("Seat 1 — 21, blackjack — wins +150,000");
    expect(labels).toContain("Seat 2 — 19, push — stake returned");
    expect(labels).toContain("Seat 3 — 24, bust — lost 100,000");
  });

  it("distinguishes a bust from a hand that simply lost", () => {
    const labels = labelsIn(BLACKJACK_TABLE.view(settledWithLoser(), null)).join(" | ");
    expect(labels).toContain("Seat 4 — 18, lost 100,000");
    expect(labels).not.toContain("Seat 4 — 18, bust");
  });

  it("leads the viewer's own panel with the result and the net figure", () => {
    const mine = ownPanel(BLACKJACK_TABLE.view(settledTable(), 0));
    expect(textsIn(mine)).toContain("Blackjack! You win");
    expect(moneysIn(mine)).toEqual(["150000"]);
    // Above the cards: the result is the first thing in the panel, not a
    // footnote under a hand the player has already read.
    const children = mine.kind === "panel" ? mine.children.map((c) => c.kind) : [];
    expect(children.slice(0, 2)).toEqual(["text", "money"]);
    expect(children.indexOf("cards")).toBeGreaterThan(1);
  });

  it("says the stake came back on a push, with no figure to misread", () => {
    const mine = ownPanel(BLACKJACK_TABLE.view(settledTable(), 1));
    expect(textsIn(mine)).toContain("Push — your stake is back");
    // A net of zero rendered as "$0" beside "stake is back" reads like a loss.
    expect(moneysIn(mine)).toEqual([]);
  });

  it("gives a losing viewer the loss as a negative net figure", () => {
    const bust = ownPanel(BLACKJACK_TABLE.view(settledTable(), 2));
    expect(textsIn(bust)).toContain("Bust — the house takes it");
    expect(moneysIn(bust)).toEqual(["-100000"]);

    const beaten = ownPanel(BLACKJACK_TABLE.view(settledWithLoser(), 3));
    expect(textsIn(beaten)).toContain("The house takes it");
    expect(moneysIn(beaten)).toEqual(["-100000"]);
  });

  it("pays a plain win at even money", () => {
    // Seat 0 stood on 20 against the dealer's 19 — 2x back, net +1x.
    const state: BjTableState = {
      ...settledTable(),
      hands: [{ seat: 0, cards: ["Sk", "Sq"], wager: W, phase: "stood" }],
    };
    const view = BLACKJACK_TABLE.view(state, 0);
    expect(textsIn(ownPanel(view))).toContain("You win");
    expect(moneysIn(ownPanel(view))).toEqual(["100000"]);
  });

  it("agrees with settleTable — the view computes the same payout the hub pays", () => {
    const state = settledWithLoser();
    const payouts = new Map(BLACKJACK_TABLE.settle(state).map((p) => [p.seat, p.payout]));
    expect(payouts.get(0)).toBe(250_000n);   // net +150,000
    expect(payouts.get(1)).toBe(100_000n);   // net 0
    expect(payouts.get(2)).toBe(0n);         // net -100,000
    expect(payouts.get(3)).toBe(0n);         // net -100,000
  });

  it("says nothing about outcomes while the hand is still live", () => {
    for (const viewer of [0, 3, null]) {
      const view = BLACKJACK_TABLE.view(liveTable(), viewer);
      const words = [...labelsIn(view), ...textsIn(view), ...rowsIn(view).map((r) => r.value)].join(" | ");
      for (const leak of ["win", "won", "wins", "lost", "push", "takes", "stake", "blackjack"]) {
        expect(words.toLowerCase()).not.toContain(leak);
      }
      expect(moneysIn(view)).toEqual([]);
    }
  });

  it("parses a settled table against the WIRE schema", async () => {
    const { BoundedViewNodeDtoSchema } = await import("@gl3/shared");
    for (const viewer of [0, 1, 2, 3, null]) {
      expect(BoundedViewNodeDtoSchema.safeParse(BLACKJACK_TABLE.view(settledWithLoser(), viewer)).success)
        .toBe(true);
    }
  });
});

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
