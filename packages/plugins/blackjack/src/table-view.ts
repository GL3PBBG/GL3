import type { ViewNode } from "@gl3/plugin-sdk";
import { handValue } from "./rules.js";
import type { BjTableState } from "./multi.js";

const FACE_DOWN = "B1";

/**
 * Solo view.ts's concealment contract, per table: while ANY seat is still
 * choosing (`!state.done`), the dealer's second card renders as a back and
 * the total as the up-card's alone. All player cards are public — blackjack's
 * only secret is the hole card, but the `viewer` parameter is the contract
 * (a poker port needs it), and here it marks "you" and "to act".
 */
export function renderTable(state: BjTableState, viewer: number | null): ViewNode {
  const hidden = !state.done;
  const dealerCards = hidden ? [state.dealer[0] ?? FACE_DOWN, FACE_DOWN] : state.dealer;
  const dealerTotal = hidden
    ? `${String(handValue(state.dealer.slice(0, 1)))} + ?`
    : String(handValue(state.dealer));

  const seatPanels: ViewNode[] = state.hands.map((hand) => {
    const marks = [
      hand.seat === viewer ? "you" : null,
      hand.seat === state.turn ? "to act" : null,
    ].filter((m): m is string => m !== null);
    const title = `Seat ${hand.seat + 1}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
    return {
      kind: "panel",
      title,
      children: [
        { kind: "cards", cards: hand.cards },
        {
          kind: "keyValue",
          rows: [
            { label: "Total", value: String(handValue(hand.cards)) },
            { label: "Status", value: hand.phase },
          ],
        },
      ],
    };
  });

  return {
    kind: "panel",
    title: "Blackjack table",
    children: [
      { kind: "panel", title: "Dealer", children: [{ kind: "cards", cards: dealerCards }] },
      {
        kind: "keyValue",
        rows: [{ label: hidden ? "Dealer showing" : "Dealer total", value: dealerTotal }],
      },
      ...seatPanels,
    ],
  };
}
