import { describe, expect, it } from "vitest";
import {
  advanceHand, checkWager, dealtHand, handActions, mergeMovePayload, usesLegacyMoves,
} from "../src/pages/Casino.js";
import type { LiveHand } from "../src/pages/Casino.js";
import {
  CasinoLobbyResponseSchema, CasinoStepResponseSchema,
} from "@gl3/shared";
import type { GameMoveDto } from "@gl3/shared";

// The route's own values: min_bet and max_bet are decimal strings, and a
// player's cash is one too. Nothing here is ever a JSON number.
const MIN = "10000";
const MAX = "50000";

describe("checkWager", () => {
  it("accepts a wager inside the limits the player can cover", () => {
    expect(checkWager("25000", MIN, MAX, "100000")).toEqual({ kind: "ok" });
  });

  it("accepts the boundaries themselves — min and max are inclusive server-side", () => {
    expect(checkWager(MIN, MIN, MAX, "100000")).toEqual({ kind: "ok" });
    expect(checkWager(MAX, MIN, MAX, "100000")).toEqual({ kind: "ok" });
  });

  it("rejects anything that isn't a run of digits", () => {
    // Mirrors the route's NonNegativeIntegerString.
    expect(checkWager("", MIN, MAX, "100000")).toEqual({ kind: "notAnAmount" });
    expect(checkWager("1.5", MIN, MAX, "100000")).toEqual({ kind: "notAnAmount" });
    expect(checkWager("-5", MIN, MAX, "100000")).toEqual({ kind: "notAnAmount" });
    expect(checkWager("1e5", MIN, MAX, "100000")).toEqual({ kind: "notAnAmount" });
  });

  it("reports the server's three refusals in the server's own order", () => {
    expect(checkWager("9999", MIN, MAX, "100000")).toEqual({ kind: "belowMin" });
    expect(checkWager("50001", MIN, MAX, "100000")).toEqual({ kind: "aboveMax" });
    expect(checkWager("25000", MIN, MAX, "24999")).toEqual({ kind: "tooPoor" });
  });

  it("stays exact past 2^53 — the reason money is a string end to end", () => {
    // Number would round both of these to 9007199254740992 and call the wager
    // affordable. BigInt does not.
    expect(checkWager("9007199254740993", "1", "9999999999999999999", "9007199254740992"))
      .toEqual({ kind: "tooPoor" });
  });
});

describe("handActions", () => {
  it("offers Double on an unplayed hand", () => {
    expect(handActions(0)).toEqual(["hit", "stand", "double"]);
  });

  it("withdraws Double once the hand has been acted on", () => {
    // blackjack accepts a double only on the opening two cards.
    expect(handActions(1)).toEqual(["hit", "stand"]);
  });

  it("still offers Double on a hand resumed from the lobby", () => {
    // The card count is not knowable from an opaque ViewNode, so a resumed
    // hand may or may not be doubleable — the server now answers a clean 400
    // when it is not, which is why this is no longer withheld. A resumed hand
    // enters with no acts recorded, exactly like a dealt one.
    expect(handActions(0)).toEqual(["hit", "stand", "double"]);
  });
});

describe("the hand on screen", () => {
  const SESSION = "0192f0a0-0000-7000-8000-000000000002";
  const view = { kind: "panel", title: "Blackjack", children: [] };

  const opened: LiveHand = {
    sessionId: SESSION,
    gameName: "Blackjack",
    stake: "25000",
    view,
    done: false,
    payout: null,
    expiresAt: null,
    actsTaken: 0,
  };

  it("takes the opening stake from the server, not from what was typed", () => {
    const hand = dealtHand(
      { sessionId: SESSION, view, done: false, wager: "25000" }, "Blackjack",
    );
    expect(hand.stake).toBe("25000");
    expect(hand.payout).toBeNull();
  });

  it("follows a DOUBLE: the stake shown is the doubled one, not the opening one", () => {
    // The whole point of `wager` on the step response. blackjack's double
    // raises the wager through GameStep.wagerDelta and settles in the same
    // call, so this response is the only place the new figure ever exists:
    // the session row is gone by the time the lobby could report it.
    const doubled = advanceHand(opened, {
      sessionId: SESSION, view, done: true, wager: "50000", payout: "125000",
    });
    expect(doubled.stake).toBe("50000");
    expect(doubled.payout).toBe("125000");
    expect(doubled.done).toBe(true);
  });

  it("leaves the stake alone on a step that does not raise it", () => {
    const hit = advanceHand(opened, { sessionId: SESSION, view, done: false, wager: "25000" });
    expect(hit.stake).toBe("25000");
    expect(hit.payout).toBeNull();
  });

  it("counts the act, which is what withdraws Double", () => {
    const hit = advanceHand(opened, { sessionId: SESSION, view, done: false, wager: "25000" });
    expect(hit.actsTaken).toBe(1);
    expect(handActions(hit.actsTaken)).toEqual(["hit", "stand"]);
  });

  it("carries `expiresAt` across a step — it is a fact about the hand, not the step", () => {
    const resumed: LiveHand = { ...opened, expiresAt: "2026-08-17T15:12:03.114Z" };
    expect(advanceHand(resumed, { sessionId: SESSION, view, done: false, wager: "25000" }).expiresAt)
      .toBe("2026-08-17T15:12:03.114Z");
  });
});

describe("usesLegacyMoves", () => {
  it("falls back to the hardcoded UI when `moves` is absent (an old server)", () => {
    expect(usesLegacyMoves(undefined)).toBe(true);
  });

  it("falls back when `moves` is null (the game doesn't speak the protocol)", () => {
    expect(usesLegacyMoves(null)).toBe(true);
  });

  it("uses the generic bar for a bounded array, even an empty one", () => {
    // [] means the game DOES speak the protocol and says: no move for you
    // right now — that is a real answer, not a fallback trigger.
    expect(usesLegacyMoves([])).toBe(false);
    expect(usesLegacyMoves([{ action: "check", label: "Check" }])).toBe(false);
  });
});

describe("mergeMovePayload", () => {
  const check: GameMoveDto = { action: { action: "check" }, label: "Check" };
  const bet: GameMoveDto = { action: { action: "bet" }, label: "Bet…", needsAmount: true };

  it("posts the move's action verbatim when it needs no amount", () => {
    expect(mergeMovePayload(check, "500")).toEqual({ action: "check" });
  });

  it("shallow-merges the typed amount in when the move needs one", () => {
    expect(mergeMovePayload(bet, "500")).toEqual({ action: "bet", amount: "500" });
  });

  it("does not mutate the move's own action object", () => {
    mergeMovePayload(bet, "500");
    expect(bet.action).toEqual({ action: "bet" });
  });
});

describe("the lobby DTO", () => {
  const lobby = {
    locationId: "0192f0a0-0000-7000-8000-000000000001",
    locationName: "Rome",
    minBet: MIN,
    games: [{ gameId: "blackjack", name: "Blackjack", ownerName: "Bob", maxBet: MAX }],
    tableGames: [],
    remote: [],
    session: null,
  };

  it("parses a lobby with no open hand", () => {
    expect(CasinoLobbyResponseSchema.parse(lobby).session).toBeNull();
  });

  it("keeps an unowned table's owner as null rather than coercing it", () => {
    const parsed = CasinoLobbyResponseSchema.parse({
      ...lobby,
      games: [{ gameId: "blackjack", name: "Blackjack", ownerName: null, maxBet: MAX }],
    });
    expect(parsed.games[0]?.ownerName).toBeNull();
  });

  it("parses an open hand, view and all", () => {
    const parsed = CasinoLobbyResponseSchema.parse({
      ...lobby,
      session: {
        sessionId: "0192f0a0-0000-7000-8000-000000000002",
        gameId: "blackjack",
        gameName: "Blackjack",
        wager: "25000",
        // A `cards` node inside the view is the point: the DTO's node schema
        // shipped without that leaf while the SDK's had it, so the whole
        // payload failed the client parse with an invalid-discriminator issue.
        view: {
          kind: "panel", title: "Blackjack",
          children: [{ kind: "cards", cards: ["Sa", "Hk", "H10"] }],
        },
        expiresAt: "2026-08-17T15:12:03.114Z",
      },
    });
    expect(parsed.session?.wager).toBe("25000");
  });

  it("parses a resumable hand the game can no longer draw", () => {
    const parsed = CasinoLobbyResponseSchema.parse({
      ...lobby,
      session: {
        sessionId: "0192f0a0-0000-7000-8000-000000000002",
        gameId: "roulette",
        gameName: "roulette",
        wager: "25000",
        view: null,
        expiresAt: "2026-08-17T15:12:03.114Z",
      },
    });
    expect(parsed.session?.view).toBeNull();
  });

  it("rejects a money field sent as a JSON number", () => {
    // The whole point of MoneySchema: a number here is a float on the wire.
    expect(() => CasinoLobbyResponseSchema.parse({ ...lobby, minBet: 10000 })).toThrow();
  });
});

describe("the step DTO", () => {
  const view = { kind: "panel", title: "Blackjack", children: [] };

  it("parses an unfinished hand, which carries a wager but no payout", () => {
    const parsed = CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002", view, done: false, wager: "25000",
    });
    expect(parsed.wager).toBe("25000");
    expect(parsed.payout).toBeUndefined();
  });

  it("parses a settled hand's payout as a decimal string", () => {
    const parsed = CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002",
      view, done: true, wager: "50000", payout: "125000",
    });
    expect(parsed.payout).toBe("125000");
  });

  it("requires the wager — both routes send it on every branch", () => {
    // Optional would buy the page a fallback that can never run and can never
    // be tested. Required says what the wire actually is.
    expect(() => CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002", view, done: false,
    })).toThrow();
  });

  it("rejects money sent as a JSON number", () => {
    expect(() => CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002",
      view, done: true, wager: "50000", payout: 125000,
    })).toThrow();
    expect(() => CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002", view, done: false, wager: 25000,
    })).toThrow();
  });
});
