import { describe, expect, it } from "vitest";
import { BLACKJACK, handValue, shuffle, type BlackjackState } from "@gl3/plugin-blackjack";

const WAGER = 100_000n;

describe("hand value", () => {
  it("counts an ace as 11 when it fits and 1 when it does not", () => {
    expect(handValue(["Sa", "Sk"])).toBe(21);
    expect(handValue(["Sa", "Sk", "H5"])).toBe(16);
    expect(handValue(["Sa", "Sa"])).toBe(12);
  });

  it("counts faces as ten", () => {
    expect(handValue(["Sj", "Hq", "Dk"])).toBe(30);
  });
});

describe("shoe", () => {
  it("is deterministic in the seed", () => {
    expect(shuffle("seed-a")).toEqual(shuffle("seed-a"));
    expect(shuffle("seed-a")).not.toEqual(shuffle("seed-b"));
  });

  it("is six full decks", () => {
    const shoe = shuffle("seed-a");
    expect(shoe).toHaveLength(312);
    expect(shoe.filter((c) => c === "Sa")).toHaveLength(6);
  });
});

describe("blackjack game", () => {
  it("deals two cards to each side and does not finish on a normal deal", () => {
    // "no-natural" was checked empirically: cards 0/2 deal player S9,S8 (17)
    // and cards 1/3 deal dealer H9,D7 (16) — neither is a natural.
    const step = BLACKJACK.start({ wager: WAGER, seed: "no-natural" });
    expect(step.state.player).toHaveLength(2);
    expect(step.state.dealer).toHaveLength(2);
    expect(step.done).toBe(false);
  });

  it("pays a natural 3:2 and ends the hand immediately", () => {
    // "natural-22" was found empirically: cards 0/2 deal player Sj,Ca (21)
    // while cards 1/3 deal dealer C9,D9 (18) — a player natural, no dealer push.
    const step = BLACKJACK.start({ wager: WAGER, seed: "natural-22" });
    expect(step.done).toBe(true);
    expect(BLACKJACK.settle(step.state, WAGER)).toBe(250_000n);
  });

  it("returns 0 when the player busts", () => {
    const state: BlackjackState = { ...baseState(), player: ["Sk", "Hq", "D5"] };
    const step = BLACKJACK.act(state, "stand");
    expect(BLACKJACK.settle(step.state, WAGER)).toBe(0n);
  });

  it("returns the wager on a push", () => {
    const state: BlackjackState = { ...baseState(), player: ["Sk", "H9"], dealer: ["Dk", "C9"] };
    const step = BLACKJACK.act(state, "stand");
    expect(step.done).toBe(true);
    expect(BLACKJACK.settle(step.state, WAGER)).toBe(WAGER);
  });

  it("stands the dealer on 17", () => {
    const state: BlackjackState = { ...baseState(), player: ["Sk", "H9"], dealer: ["Dk", "C7"] };
    const step = BLACKJACK.act(state, "stand");
    expect(step.state.dealer).toHaveLength(2);   // no third card drawn on 17
  });

  it("doubling asks the hub for exactly one more wager and ends the hand", () => {
    const state: BlackjackState = { ...baseState(), player: ["S5", "H6"] };
    const step = BLACKJACK.act(state, "double");
    expect(step.wagerDelta).toBe(WAGER);
    expect(step.done).toBe(true);
  });

  it("refuses to double after the first two cards", () => {
    const state: BlackjackState = { ...baseState(), player: ["S5", "H6", "D2"] };
    expect(() => BLACKJACK.act(state, "double")).toThrow(/double/i);
  });

  it("rejects an action its schema does not allow", () => {
    expect(BLACKJACK.action.safeParse("split").success).toBe(false);
    expect(BLACKJACK.action.safeParse("hit").success).toBe(true);
  });
});

/** A state whose shoe has plenty left, for the hand-constructed cases above. */
function baseState(): BlackjackState {
  return { shoe: shuffle("fixture"), cursor: 4, player: [], dealer: [], wager: WAGER, phase: "player" };
}
