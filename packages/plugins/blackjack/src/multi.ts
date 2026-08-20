import { handValue, isNatural, shuffle, type Card } from "./rules.js";
import type { TableSeatInput } from "@gl3/plugin-casino";

export type SeatPhase = "playing" | "stood" | "bust" | "natural" | "doubled";

export interface BjSeatHand { seat: number; cards: Card[]; wager: bigint; phase: SeatPhase }

export interface BjTableState {
  shoe: Card[];
  cursor: number;
  hands: BjSeatHand[];
  dealer: Card[];
  turn: number | null;
  done: boolean;
}

/** Lowest-numbered seat still to act, or null. */
function nextTurn(hands: readonly BjSeatHand[]): number | null {
  const open = hands.find((h) => h.phase === "playing");
  return open === undefined ? null : open.seat;
}

/**
 * Dealer plays iff at least one seat STOOD (incl. doubled) — a table of
 * busts and naturals has nobody to beat, so the dealer only reveals.
 * Stands on all 17, `rules.ts`'s playDealer rule over the table state shape.
 */
function finishHand(state: BjTableState): BjTableState {
  const contested = state.hands.some((h) => h.phase === "stood" || h.phase === "doubled");
  const dealer = [...state.dealer];
  let cursor = state.cursor;
  if (contested) {
    while (handValue(dealer) < 17) dealer.push(state.shoe[cursor++]!);
  }
  return { ...state, dealer, cursor, turn: null, done: true };
}

function advance(state: BjTableState): BjTableState {
  const turn = nextTurn(state.hands);
  if (turn === null) return finishHand(state);
  return { ...state, turn };
}

export function dealTable(seats: TableSeatInput[], seed: string): BjTableState {
  if (seats.length === 0) throw new Error("cannot deal to an empty table");
  const shoe = shuffle(seed);
  const ordered = [...seats].sort((a, b) => a.seat - b.seat);
  let cursor = 0;
  const first = ordered.map(() => shoe[cursor++]!);
  const upCard = shoe[cursor++]!;
  const second = ordered.map(() => shoe[cursor++]!);
  const hole = shoe[cursor++]!;
  const hands: BjSeatHand[] = ordered.map((s, i) => {
    const cards = [first[i]!, second[i]!];
    return { seat: s.seat, cards, wager: s.wager, phase: isNatural(cards) ? "natural" : "playing" };
  });
  return advance({ shoe, cursor, hands, dealer: [upCard, hole], turn: null, done: false });
}

function withHand(state: BjTableState, seat: number, hand: BjSeatHand, cursor?: number): BjTableState {
  return {
    ...state,
    cursor: cursor ?? state.cursor,
    hands: state.hands.map((h) => (h.seat === seat ? hand : h)),
  };
}

export function actSeat(
  state: BjTableState, seat: number, action: "hit" | "stand" | "double",
): { state: BjTableState; wagerDelta?: { seat: number; amount: bigint } } {
  if (state.done) throw new Error("hand is already finished");
  if (state.turn !== seat) throw new Error("not this seat's turn");
  const hand = state.hands.find((h) => h.seat === seat);
  if (hand === undefined || hand.phase !== "playing") throw new Error("seat is not in play");

  if (action === "hit") {
    const cards = [...hand.cards, state.shoe[state.cursor]!];
    const bust = handValue(cards) > 21;
    const next = withHand(state, seat, { ...hand, cards, phase: bust ? "bust" : "playing" }, state.cursor + 1);
    return { state: bust ? advance(next) : next };
  }

  if (action === "double") {
    if (hand.cards.length !== 2) throw new Error("can only double on the first two cards");
    const cards = [...hand.cards, state.shoe[state.cursor]!];
    const phase: SeatPhase = handValue(cards) > 21 ? "bust" : "doubled";
    const next = withHand(state, seat, { ...hand, cards, wager: hand.wager * 2n, phase }, state.cursor + 1);
    // The hub debits the seat, credits the house and re-runs the exposure
    // check — this function moves no money (solo double's contract).
    return { state: advance(next), wagerDelta: { seat, amount: hand.wager } };
  }

  return { state: advance(withHand(state, seat, { ...hand, phase: "stood" })) };
}

/** Solo `settle`'s payout table, per seat, against the one dealer hand. */
export function settleTable(state: BjTableState): { seat: number; payout: bigint }[] {
  const dealer = handValue(state.dealer);
  const dealerNatural = isNatural(state.dealer);
  return state.hands.map((hand) => {
    const value = handValue(hand.cards);
    let payout = 0n;
    if (value <= 21) {
      if (hand.phase === "natural" && !dealerNatural) payout = (hand.wager * 5n) / 2n;
      else if (dealer > 21 || value > dealer) payout = hand.wager * 2n;
      else if (value === dealer) payout = hand.wager;
    }
    return { seat: hand.seat, payout };
  });
}
