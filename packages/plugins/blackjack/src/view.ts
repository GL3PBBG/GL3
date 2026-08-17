import type { ViewNode } from "@gl3/plugin-sdk";
import { handValue, type BlackjackState } from "./rules.js";

/**
 * Pure render of a hand at any point in play. No io, no ctx — the same
 * purity rule as `rules.ts`, so a game plugin can be trusted to describe
 * what the player sees without touching anything else.
 */
export function renderState(state: BlackjackState): ViewNode {
  return {
    kind: "panel",
    title: "Blackjack",
    children: [
      { kind: "panel", title: "Dealer", children: [{ kind: "cards", cards: state.dealer }] },
      { kind: "panel", title: "Player", children: [{ kind: "cards", cards: state.player }] },
      {
        kind: "keyValue",
        rows: [
          { label: "Dealer total", value: String(handValue(state.dealer)) },
          { label: "Player total", value: String(handValue(state.player)) },
          { label: "Phase", value: state.phase },
        ],
      },
    ],
  };
}
