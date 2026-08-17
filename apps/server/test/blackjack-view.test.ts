import { describe, expect, it } from "vitest";
import type { ViewNode } from "@gl3/plugin-sdk";
import { BLACKJACK, type BlackjackState } from "@gl3/plugin-blackjack";

/**
 * What a player can SEE, as opposed to what the hand contains.
 *
 * The rest of this cluster's tests assert money and status; nothing asserted
 * view CONTENT at all, which is how the dealer's hole card shipped face-up
 * through eleven task reviews. A blackjack view that reveals the dealer's
 * second card and true total before the player chooses hit/stand/double is
 * worth roughly +7-10% EV to the player — it inverts the house edge, and the
 * house is a player-owned franchise.
 *
 * Everything here goes through the GameDef's own surface (`start`, `act`,
 * `view`), because that is exactly what the hub calls and hands to the page.
 */

const WAGER = 100_000n;

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

/** A hand mid-play: the player has decided nothing yet. */
function liveState(): BlackjackState {
  return {
    shoe: ["H4", "D9", "S2", "S3"],
    cursor: 0,
    player: ["S9", "S8"],           // 17
    dealer: ["Hk", "Da"],           // up-card Hk (10), hole card Da — 21 if seen
    wager: WAGER,
    phase: "player",
  };
}

describe("the dealer's hole card", () => {
  it("is face-down while the player is still choosing", () => {
    const view = BLACKJACK.view?.(liveState());
    expect(view).toBeDefined();
    const cards = cardsIn(view!);

    // The player's own two cards, the dealer's UP-card, and a back. Not the
    // hole card: `Da` is what the player must not be shown.
    expect(cards).toContain("Hk");
    expect(cards).not.toContain("Da");
    expect(cards.filter((c) => c === "B1" || c === "B2")).toHaveLength(1);
    expect(cards).toEqual(expect.arrayContaining(["S9", "S8"]));
  });

  it("does not leak through the dealer's total either", () => {
    const view = BLACKJACK.view?.(liveState());
    // 21 is the dealer's real total and must not appear anywhere in the rows.
    // 10 (the up-card alone) or "?" are the only honest answers.
    expect(rowsIn(view!).map((r) => r.value)).not.toContain("21");
    // The player's own total is never hidden — it is the number they act on.
    expect(valueOf(view!, "Player total")).toBe("17");
  });

  it("stays hidden in the view `act` returns for an unfinished hand", () => {
    const step = BLACKJACK.act(liveState(), "hit");
    expect(step.done).toBe(false);
    const cards = cardsIn(step.view);
    expect(cards).not.toContain("Da");
    expect(cards.filter((c) => c === "B1" || c === "B2")).toHaveLength(1);
  });

  it("stays hidden in the view `start` returns for a hand that is still live", () => {
    // "no-natural" deals player S9,S8 (17) and dealer H9,D7 (16) —
    // blackjack-rules.test.ts pins that seed.
    const step = BLACKJACK.start({ wager: WAGER, seed: "no-natural" });
    expect(step.done).toBe(false);
    const cards = cardsIn(step.view);
    expect(cards).toContain(step.state.dealer[0]!);
    expect(cards).not.toContain(step.state.dealer[1]!);
  });
});

describe("the reveal", () => {
  it("shows both dealer cards and the true total once the hand is done", () => {
    const step = BLACKJACK.act(liveState(), "stand");
    expect(step.done).toBe(true);
    const cards = cardsIn(step.view);
    expect(cards).toContain("Hk");
    expect(cards).toContain("Da");
    expect(cards.filter((c) => c === "B1" || c === "B2")).toHaveLength(0);
    // Dealer stands on 21, so the final total is the one that was hidden.
    expect(valueOf(step.view, "Dealer total")).toBe("21");
  });

  it("shows everything on a hand that settles at the deal", () => {
    // "natural-22": player Sj,Ca (21), dealer C9,D9 (18) — done at `start`,
    // so there is nothing left to conceal.
    const step = BLACKJACK.start({ wager: WAGER, seed: "natural-22" });
    expect(step.done).toBe(true);
    const cards = cardsIn(step.view);
    expect(cards).toContain(step.state.dealer[0]!);
    expect(cards).toContain(step.state.dealer[1]!);
    expect(cards.filter((c) => c === "B1" || c === "B2")).toHaveLength(0);
  });
});
