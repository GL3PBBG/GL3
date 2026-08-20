import { describe, expect, it } from "vitest";
import {
  dealTable, actSeat, settleTable, type BjTableState, type BjSeatHand,
} from "@gl3/plugin-blackjack";
import { shuffle, handValue } from "@gl3/plugin-blackjack";

const W = 100_000n;

/** Hand-built state, `blackjack-rules.test.ts`'s baseState idiom. */
function state(hands: Partial<BjSeatHand>[], dealer: string[], over?: Partial<BjTableState>): BjTableState {
  return {
    shoe: shuffle("fixture"), cursor: 4, dealer,
    hands: hands.map((h, i) => ({ seat: i, cards: [], wager: W, phase: "playing", ...h })),
    turn: 0, done: false, ...over,
  };
}

describe("dealTable", () => {
  it("deals two cards per seat and two to the dealer, in casino order", () => {
    const s = dealTable([{ seat: 0, wager: W }, { seat: 2, wager: W }], "seed-a");
    const shoe = shuffle("seed-a");
    // Round one: seat 0, seat 2, dealer up-card. Round two: seat 0, seat 2, hole.
    expect(s.hands[0]!.cards).toEqual([shoe[0], shoe[3]]);
    expect(s.hands[1]!.cards).toEqual([shoe[1], shoe[4]]);
    expect(s.dealer).toEqual([shoe[2], shoe[5]]);
    expect(s.cursor).toBe(6);
  });

  it("gives the turn to the lowest playing seat", () => {
    const s = dealTable([{ seat: 1, wager: W }, { seat: 4, wager: W }], "no-natural");
    expect(s.done).toBe(false);
    expect(s.turn).toBe(1);
  });

  it("auto-stands a dealt natural and skips its turn", () => {
    // Constructive: find a seed dealing seat 0 a natural with ≥2 seats by
    // scanning — deterministic once found, the "natural-22" precedent.
    let seed = "";
    for (let i = 0; i < 500; i++) {
      const probe = dealTable([{ seat: 0, wager: W }, { seat: 1, wager: W }], `probe-${i}`);
      if (probe.hands[0]!.phase === "natural" && probe.hands[1]!.phase === "playing") { seed = `probe-${i}`; break; }
    }
    expect(seed).not.toBe("");
    const s = dealTable([{ seat: 0, wager: W }, { seat: 1, wager: W }], seed);
    expect(s.turn).toBe(1);
  });

  it("plays the dealer and finishes at the deal when every seat naturals", () => {
    let found: BjTableState | null = null;
    for (let i = 0; i < 5000 && found === null; i++) {
      const probe = dealTable([{ seat: 0, wager: W }], `solo-${i}`);
      if (probe.hands[0]!.phase === "natural") found = probe;
    }
    expect(found).not.toBeNull();
    expect(found!.done).toBe(true);
    expect(found!.turn).toBeNull();
  });
});

describe("actSeat", () => {
  it("refuses an act out of turn", () => {
    const s = state([{ cards: ["S9", "S8"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    expect(() => actSeat(s, 1, "hit")).toThrow(/turn/i);
  });

  it("hit draws one card at the cursor and keeps the turn on a live hand", () => {
    const s = state([{ cards: ["S2", "S3"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    const { state: next } = actSeat(s, 0, "hit");
    expect(next.hands[0]!.cards).toHaveLength(3);
    expect(next.cursor).toBe(5);
    expect(next.turn).toBe(0);
  });

  it("a stand passes the turn to the next playing seat", () => {
    const st = state([{ cards: ["Sk", "Sq"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    const { state: next } = actSeat(st, 0, "stand");
    expect(next.hands[0]!.phase).toBe("stood");
    expect(next.turn).toBe(1);
  });

  it("the last stand plays the dealer (stands on all 17) and finishes", () => {
    const s = state([{ cards: ["Sk", "S9" ] }], ["Dk", "C7"]);
    const { state: next } = actSeat(s, 0, "stand");
    expect(next.done).toBe(true);
    expect(next.turn).toBeNull();
    expect(next.dealer).toHaveLength(2); // 17: no draw
  });

  it("the dealer only reveals, never draws, when every seat busted", () => {
    const s = state([{ cards: ["Sk", "Sq" ] }], ["D6", "C5"]); // dealer 11 would draw
    const { state: mid } = actSeat(s, 0, "hit"); // Sk Sq + next card is always a bust
    expect(mid.hands[0]!.phase).toBe("bust");
    expect(mid.done).toBe(true);
    expect(mid.dealer).toHaveLength(2); // nobody to beat — no draw
  });

  it("double draws one card, doubles that seat's wager and asks the hub for the delta", () => {
    const s = state([{ cards: ["S5", "H6"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    const { state: next, wagerDelta } = actSeat(s, 0, "double");
    expect(wagerDelta).toEqual({ seat: 0, amount: W });
    expect(next.hands[0]!.wager).toBe(W * 2n);
    expect(next.hands[0]!.cards).toHaveLength(3);
    expect(next.turn).toBe(1);
  });

  it("refuses double after the first two cards", () => {
    const s = state([{ cards: ["S5", "H6", "D2"] }], ["Dk", "D9"]);
    expect(() => actSeat(s, 0, "double")).toThrow(/double/i);
  });
});

describe("settleTable", () => {
  const settled = (hands: Partial<BjSeatHand>[], dealer: string[]) =>
    settleTable(state(hands, dealer, { done: true, turn: null }));

  it("pays each seat independently against the one dealer", () => {
    const payouts = settled([
      { cards: ["Sk", "Sq"], phase: "stood" },          // 20 beats 19 → 2×
      { cards: ["H9", "H8"], phase: "stood" },          // 17 loses → 0
      { cards: ["Sa", "Hk"], phase: "natural" },        // natural → 2.5×
      { cards: ["Dk", "Dq", "D5"], phase: "bust" },     // bust → 0
      { cards: ["C9", "Ck"], phase: "stood" },          // 19 push → 1×
    ].map((h, i) => ({ ...h, seat: i })), ["Hk", "H9"]); // dealer 19
    expect(payouts).toEqual([
      { seat: 0, payout: W * 2n },
      { seat: 1, payout: 0n },
      { seat: 2, payout: (W * 5n) / 2n },
      { seat: 3, payout: 0n },
      { seat: 4, payout: W },
    ]);
  });

  it("a doubled win pays 2× the doubled wager", () => {
    const payouts = settleTable(state(
      [{ seat: 0, cards: ["S5", "H6", "Sk"], wager: W * 2n, phase: "doubled" }],
      ["Hk", "H9"], { done: true, turn: null },
    ));
    expect(payouts).toEqual([{ seat: 0, payout: W * 4n }]);
  });

  it("dealer bust pays every standing seat", () => {
    const payouts = settled(
      [{ seat: 0, cards: ["S9", "H8"], phase: "stood" }],
      ["Dk", "Dq", "D5"],
    );
    expect(payouts).toEqual([{ seat: 0, payout: W * 2n }]);
  });

  it("both natural is a push at 1×", () => {
    const payouts = settled(
      [{ seat: 0, cards: ["Sa", "Sk"], phase: "natural" }],
      ["Da", "Dk"],
    );
    expect(payouts).toEqual([{ seat: 0, payout: W }]);
  });
});
