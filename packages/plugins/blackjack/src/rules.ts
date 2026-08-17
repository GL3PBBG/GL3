import { createHash } from "node:crypto";

export type Card = string;                      // a @letele/playing-cards code
export type Phase = "player" | "done";

export interface BlackjackState {
  shoe: Card[];
  cursor: number;
  player: Card[];
  dealer: Card[];
  wager: bigint;
  phase: Phase;
}

const SUITS = ["H", "D", "C", "S"] as const;
const RANKS = ["a", "2", "3", "4", "5", "6", "7", "8", "9", "10", "j", "q", "k"] as const;
const DECKS = 6;

/**
 * A six-deck shoe, shuffled ONCE and stored, which is how this satisfies
 * SPEC §7. The rule's intent is that a retry cannot re-roll a favourable
 * outcome; here no later roll exists to re-roll, because every `act` is a
 * deterministic read of a committed shoe.
 *
 * Deterministic in the seed so a disputed hand can be replayed from the
 * session's `seed` column. The seed itself comes from `node:crypto` at the
 * hub (never `Math.random`, SPEC §7); this function only expands it.
 */
export function shuffle(seed: string): Card[] {
  const shoe: Card[] = [];
  for (let d = 0; d < DECKS; d++) {
    for (const s of SUITS) for (const r of RANKS) shoe.push(`${s}${r}`);
  }
  // Fisher-Yates driven by a SHA-256 counter stream — no floating point, and
  // reproducible across Node versions, which `Math.random` would not be.
  let counter = 0;
  const next = (): number => {
    const digest = createHash("sha256").update(`${seed}:${counter++}`).digest();
    return digest.readUInt32BE(0);
  };
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const a = shoe[i]!, b = shoe[j]!;
    shoe[i] = b; shoe[j] = a;
  }
  return shoe;
}

export function handValue(hand: readonly Card[]): number {
  let total = 0, aces = 0;
  for (const card of hand) {
    const rank = card.slice(1);
    if (rank === "a") { aces++; total += 11; }
    else if (rank === "j" || rank === "q" || rank === "k" || rank === "10") total += 10;
    else total += Number(rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export function isNatural(hand: readonly Card[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}

/** Dealer stands on all 17. Mutates a copy, never its argument. */
export function playDealer(state: BlackjackState): BlackjackState {
  const dealer = [...state.dealer];
  let cursor = state.cursor;
  while (handValue(dealer) < 17) dealer.push(state.shoe[cursor++]!);
  return { ...state, dealer, cursor, phase: "done" };
}
