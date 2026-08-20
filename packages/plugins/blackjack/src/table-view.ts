import type { ViewNode } from "@gl3/plugin-sdk";
import { handValue } from "./rules.js";
import { settleTable, type BjSeatHand, type BjTableState } from "./multi.js";

const FACE_DOWN = "B1";

/** What a finished seat did, and by how much — NET of its own stake. */
interface SeatOutcome {
  net: bigint;
  kind: "natural" | "win" | "push" | "bust" | "loss";
}

/**
 * The payouts the hub is about to pay (or has paid), read back through the very
 * function that computes them — `settleTable` is pure and a settled table
 * retains the state it was settled from, so the view can restate the result
 * without the hub having to carry it.
 *
 * Figures are NET, not the total returned. `settleTable` hands back the stake
 * INSIDE the payout (a 100,000 wager that wins pays 200,000), so "won 200,000"
 * reads as double what the hand was worth. Every figure here is
 * `payout - wager`: a win is what the player is up, a loss is what they are
 * down, and a push is neither.
 */
function outcomesOf(state: BjTableState): Map<number, SeatOutcome> {
  const out = new Map<number, SeatOutcome>();
  for (const { seat, payout } of settleTable(state)) {
    const hand = state.hands.find((h) => h.seat === seat);
    if (hand === undefined) continue;
    const net = payout - hand.wager;
    const kind: SeatOutcome["kind"] =
      payout === 0n ? (hand.phase === "bust" ? "bust" : "loss")
      : net === 0n ? "push"
      : hand.phase === "natural" ? "natural"
      : "win";
    out.set(seat, { net, kind });
  }
  return out;
}

/**
 * Thousands separators for a figure that has to live inside a caption STRING.
 * The view vocabulary's `money` leaf formats itself in the browser, but a
 * `cards` caption is plain text and there is nowhere for it to hook in — so
 * this is `apps/web`'s `formatAmount` grouping, in bigint, for that one place.
 */
function group(value: bigint): string {
  const digits = (value < 0n ? -value : value).toString();
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** A third-person outcome clause for a seat that is not the viewer's. */
function outcomeClause(outcome: SeatOutcome): string {
  switch (outcome.kind) {
    case "natural": return `blackjack — wins +${group(outcome.net)}`;
    case "win": return `wins +${group(outcome.net)}`;
    case "push": return "push — stake returned";
    case "bust": return `bust — lost ${group(outcome.net)}`;
    case "loss": return `lost ${group(outcome.net)}`;
  }
}

/**
 * The viewer's own result, second person and figure-first: a `text` headline
 * and the net as a `money` leaf, which the renderer runs through `formatMoney`
 * so it arrives as `$150,000` / `-$100,000` rather than a bare digit run.
 *
 * A push carries no `money` node deliberately — a net of zero rendered as "$0"
 * next to "your stake is back" reads like the stake went to the house.
 */
function ownResult(outcome: SeatOutcome): ViewNode[] {
  const money: ViewNode = { kind: "money", value: outcome.net.toString() };
  switch (outcome.kind) {
    case "natural": return [{ kind: "text", value: "Blackjack! You win" }, money];
    case "win": return [{ kind: "text", value: "You win" }, money];
    case "push": return [{ kind: "text", value: "Push — your stake is back" }];
    case "bust": return [{ kind: "text", value: "Bust — the house takes it" }, money];
    case "loss": return [{ kind: "text", value: "The house takes it" }, money];
  }
}

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

/**
 * "Seat 2 (to act) — 17, playing" while the hand runs, "Seat 2 — 20, wins
 * +100,000" once it is over: everything a caption can say about a hand it does
 * not own. The phase is what a live hand has to report; once settled the phase
 * is a worse answer than the outcome, so the outcome replaces it.
 */
function seatCaption(hand: BjSeatHand, turn: number | null, outcome?: SeatOutcome): string {
  const mark = hand.seat === turn ? " (to act)" : "";
  const tail = outcome === undefined ? hand.phase : outcomeClause(outcome);
  return `Seat ${String(hand.seat + 1)}${mark} — ${String(handValue(hand.cards))}, ${tail}`;
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
  // Only once the hand is over: while it is live nobody, viewer or spectator,
  // learns anything the concealment contract has not already released.
  const outcomes = state.done ? outcomesOf(state) : new Map<number, SeatOutcome>();

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
        caption: seatCaption(hand, state.turn, outcomes.get(hand.seat)),
      })),
    });
  }

  if (mine !== undefined) {
    const mark = mine.seat === state.turn ? " (to act)" : "";
    const result = outcomes.get(mine.seat);
    items.push({
      kind: "panel",
      title: `Seat ${String(mine.seat + 1)} — your hand${mark}`,
      children: [
        // Above the cards, not below: this is the one place a player learns
        // what the hand paid, and a reveal that buries it under a hand they
        // have already read is the UAT finding this exists to fix.
        ...(result === undefined ? [] : ownResult(result)),
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
