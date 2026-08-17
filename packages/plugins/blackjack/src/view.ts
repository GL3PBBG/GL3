import type { ViewNode } from "@gl3/plugin-sdk";
import { handValue, type BlackjackState } from "./rules.js";

/** The face-down back the SDK's card vocabulary reserves for exactly this
 *  (`plugin-sdk/src/pages.ts`: `B1`/`B2`). */
const FACE_DOWN = "B1";

/**
 * Pure render of a hand at any point in play. No io, no ctx — the same
 * purity rule as `rules.ts`, so a game plugin can be trusted to describe
 * what the player sees without touching anything else.
 *
 * WHILE THE PLAYER IS CHOOSING, THE DEALER'S SECOND CARD IS FACE-DOWN and its
 * total is the up-card's alone. This is the whole house edge: a player who can
 * see the hole card knows whether the dealer must draw, which is worth roughly
 * +7-10% EV and inverts the edge against a player-owned house. The hand is
 * dealt in full at `start` (the shoe is shuffled once and stored), so hiding
 * it is a rendering decision and nothing else — `state.dealer` is complete
 * either way. `phase` is the only thing that decides: `"player"` conceals,
 * `"done"` reveals, and there is no third phase (`rules.ts`).
 *
 * Pinned by `apps/server/test/blackjack-view.test.ts`, which asserts against
 * this function through `GameDef.start`/`act`/`view` — the same three entry
 * points the hub calls.
 */
export function renderState(state: BlackjackState): ViewNode {
  const hidden = state.phase === "player";
  // The up-card plus a back, never the hole card itself: a code that is never
  // emitted cannot be read off the wire. The dealer holds exactly two cards
  // in this phase — it only ever draws in `playDealer`, which sets `done`.
  const dealerCards = hidden ? [state.dealer[0] ?? FACE_DOWN, FACE_DOWN] : state.dealer;
  const dealerTotal = hidden
    // The up-card's own value, which the player can see anyway. Not the hand's.
    ? `${String(handValue(state.dealer.slice(0, 1)))} + ?`
    : String(handValue(state.dealer));

  return {
    kind: "panel",
    title: "Blackjack",
    children: [
      { kind: "panel", title: "Dealer", children: [{ kind: "cards", cards: dealerCards }] },
      { kind: "panel", title: "Player", children: [{ kind: "cards", cards: state.player }] },
      {
        kind: "keyValue",
        rows: [
          { label: hidden ? "Dealer showing" : "Dealer total", value: dealerTotal },
          { label: "Player total", value: String(handValue(state.player)) },
          { label: "Phase", value: state.phase },
        ],
      },
    ],
  };
}
