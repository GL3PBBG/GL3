import type { ViewNode } from "@gl3/plugin-sdk";
import { handValue } from "./rules.js";
import type { BjSeatHand, BjTableState } from "./multi.js";

const FACE_DOWN = "B1";

/**
 * How small the other seats' hands are drawn.
 *
 * Three or more of them and the row has to shrink to stay one row: a `sm` hand
 * of five cards is 176px and the content column inside a panel is 803px, so
 * four fit with room to spare where four `md` hands (296px each) would not.
 * The arithmetic lives beside the sizes themselves, in `pages.module.css`.
 */
function opponentSize(count: number): "sm" | "md" {
  return count >= 3 ? "sm" : "md";
}

/** "Seat 2 (to act) — 17, playing": everything a caption can say about a hand it does not own. */
function seatCaption(hand: BjSeatHand, turn: number | null): string {
  const mark = hand.seat === turn ? " (to act)" : "";
  return `Seat ${String(hand.seat + 1)}${mark} — ${String(handValue(hand.cards))}, ${hand.phase}`;
}

/**
 * Solo view.ts's concealment contract, per table: while ANY seat is still
 * choosing (`!state.done`), the dealer's second card renders as a back and
 * the total as the up-card's alone. All player cards are public — blackjack's
 * only secret is the hole card, but the `viewer` parameter is the contract
 * (a poker port needs it), and here it marks "you" and "to act".
 *
 * The SHAPE is a table, not a list of seats. A panel per seat rendered as a
 * vertical stack — the renderer flattens a nested panel to a sibling one — so
 * a filling table pushed the dealer off the top of the screen and buried the
 * viewer's own hand somewhere in the middle. Three groups instead: the dealer,
 * then every OTHER seat side by side in one `layout: "row"` panel of captioned
 * hands, then the viewer's own hand last and largest. The viewer is the reason
 * this can be done in the view rather than in CSS — only the view knows which
 * seat is "mine".
 */
export function renderTable(state: BjTableState, viewer: number | null): ViewNode {
  const hidden = !state.done;
  const dealerCards = hidden ? [state.dealer[0] ?? FACE_DOWN, FACE_DOWN] : state.dealer;
  const dealerTotal = hidden
    ? `${String(handValue(state.dealer.slice(0, 1)))} + ?`
    : String(handValue(state.dealer));

  const mine = viewer === null ? undefined : state.hands.find((hand) => hand.seat === viewer);
  const others = state.hands.filter((hand) => hand.seat !== viewer);
  const size = opponentSize(others.length);

  const items: ViewNode[] = [
    {
      kind: "panel",
      title: "Dealer",
      children: [
        { kind: "cards", cards: dealerCards, size: "lg" },
        {
          kind: "keyValue",
          rows: [{ label: hidden ? "Dealer showing" : "Dealer total", value: dealerTotal }],
        },
      ],
    },
  ];

  // Leaf children only, deliberately: a nested panel inside a `row` panel would
  // flatten back out to a sibling and break the row (PageRenderer's PanelGroup
  // comment). A captioned `cards` node is what carries a seat's identity here.
  if (others.length > 0) {
    items.push({
      kind: "panel",
      title: others.length === 1 ? "The other seat" : "The other seats",
      layout: "row",
      children: others.map((hand): ViewNode => ({
        kind: "cards",
        cards: hand.cards,
        size,
        caption: seatCaption(hand, state.turn),
      })),
    });
  }

  if (mine !== undefined) {
    const mark = mine.seat === state.turn ? " (to act)" : "";
    items.push({
      kind: "panel",
      title: `Seat ${String(mine.seat + 1)} — your hand${mark}`,
      children: [
        { kind: "cards", cards: mine.cards, size: "lg" },
        {
          kind: "keyValue",
          rows: [
            { label: "Total", value: String(handValue(mine.cards)) },
            { label: "Status", value: mine.phase },
          ],
        },
      ],
    });
  }

  // A list, not a panel: the page already titles the screen with the game and
  // the town, so an outer panel here only ever rendered as an empty titled box
  // above the dealer.
  return { kind: "list", items };
}
