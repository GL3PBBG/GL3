import { describe, expect, it } from "vitest";
import { checkWager, handActions } from "../src/pages/Casino.js";
import {
  CasinoLobbyResponseSchema, CasinoStepResponseSchema,
} from "@gl3/shared";

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
  it("offers Double only on a freshly dealt, unplayed hand", () => {
    expect(handActions("dealt", 0)).toEqual(["hit", "stand", "double"]);
  });

  it("withdraws Double once the hand has been acted on", () => {
    // blackjack's `act` throws a plain Error (a 500, not a clean refusal) on a
    // double past the opening two cards.
    expect(handActions("dealt", 1)).toEqual(["hit", "stand"]);
  });

  it("withdraws Double on a hand resumed from the lobby", () => {
    // The card count is not knowable from an opaque ViewNode, so a resumed
    // hand is treated as already in progress.
    expect(handActions("resumed", 0)).toEqual(["hit", "stand"]);
  });
});

describe("the lobby DTO", () => {
  const lobby = {
    locationId: "0192f0a0-0000-7000-8000-000000000001",
    locationName: "Rome",
    minBet: MIN,
    games: [{ gameId: "blackjack", name: "Blackjack", ownerName: "Bob", maxBet: MAX }],
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

  it("parses an unfinished hand, which carries no payout", () => {
    const parsed = CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002", view, done: false,
    });
    expect(parsed.payout).toBeUndefined();
  });

  it("parses a settled hand's payout as a decimal string", () => {
    const parsed = CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002", view, done: true, payout: "50000",
    });
    expect(parsed.payout).toBe("50000");
  });

  it("rejects a payout sent as a JSON number", () => {
    expect(() => CasinoStepResponseSchema.parse({
      sessionId: "0192f0a0-0000-7000-8000-000000000002", view, done: true, payout: 50000,
    })).toThrow();
  });
});
