import { describe, expect, it } from "vitest";
import { CasinoTableResponseSchema } from "@gl3/shared";
import type { CasinoTableSeat, CasinoTableView } from "@gl3/shared";
import { tableActions } from "../src/pages/Casino.js";

/**
 * `tableActions` — which controls a seat at a SHARED table is offered.
 *
 * The solo page's `checkWager` and `handActions` are covered by
 * casino-page.test.ts; this is the multiplayer half, where the answer depends
 * on the phase, on whose turn it is, and on whether this seat is in the hand
 * at all rather than on anything the player typed.
 */
const MIN = "10000";
const MAX = "50000";
const TABLE_ID = "0192f0a0-0000-7000-8000-000000000010";
const LOCATION_ID = "0192f0a0-0000-7000-8000-000000000001";

function seat(over: Partial<CasinoTableSeat> = {}): CasinoTableSeat {
  return { seat: 0, playerId: "00000000-0000-7000-8000-000000000001", username: "Punter", wager: "0", leaving: false, idleHands: 0, ...over };
}

function view(over: Partial<CasinoTableView> = {}): CasinoTableView {
  return {
    tableId: TABLE_ID,
    gameId: "blackjack",
    gameName: "Blackjack",
    locationId: LOCATION_ID,
    locationName: "Rome",
    phase: "betting",
    handNo: 0,
    deadlineAt: null,
    turnSeat: null,
    mySeat: 0,
    minBet: MIN,
    maxBet: MAX,
    seats: [seat(), seat({ seat: 1, username: "Other" })],
    view: null,
    ...over,
  };
}

describe("tableActions in the betting phase", () => {
  it("offers the bet to a seat that has not staked yet", () => {
    expect(tableActions(view(), "100000")).toEqual({
      canBet: true, canAct: false, canDouble: false, reason: null,
    });
  });

  it("withdraws it once this seat's stake is in, and says what it is waiting for", () => {
    const staked = view({ seats: [seat({ wager: MIN }), seat({ seat: 1, username: "Other" })] });
    const actions = tableActions(staked, "100000");
    expect(actions.canBet).toBe(false);
    expect(actions.reason).toMatch(/stake is in/i);
  });

  it("withdraws it from a player who cannot cover the MINIMUM bet", () => {
    // Nothing is typed yet, so the test is whether a legal bet exists at all:
    // the cheapest one this table takes is `minBet`.
    const actions = tableActions(view(), "9999");
    expect(actions.canBet).toBe(false);
    expect(actions.reason).toMatch(/minimum bet/i);
  });

  it("offers it to a player holding exactly the minimum — the bound is inclusive", () => {
    expect(tableActions(view(), MIN).canBet).toBe(true);
  });

  it("stays exact past 2^53, like every other money comparison here", () => {
    const rich = view({ minBet: "9007199254740993", maxBet: "9999999999999999999" });
    // Number would round both sides to 9007199254740992 and call it affordable.
    expect(tableActions(rich, "9007199254740992").canBet).toBe(false);
  });

  it("offers no action at all — betting is not acting", () => {
    const actions = tableActions(view(), "100000");
    expect(actions.canAct).toBe(false);
    expect(actions.canDouble).toBe(false);
  });
});

describe("tableActions in the acting phase", () => {
  const acting = (over: Partial<CasinoTableView> = {}): CasinoTableView => view({
    phase: "acting",
    handNo: 1,
    turnSeat: 0,
    seats: [seat({ wager: MIN }), seat({ seat: 1, username: "Other", wager: MIN })],
    ...over,
  });

  it("offers hit, stand and double when it is my turn", () => {
    expect(tableActions(acting(), "100000")).toEqual({
      canBet: false, canAct: true, canDouble: true, reason: null,
    });
  });

  it("offers Double whenever it offers Act — the card count is not knowable here", () => {
    // The table's `view` is an opaque ViewNode the page walks but does not
    // interpret, and the server refuses an illegal double with a clean 400.
    // `handActions`' precedent, applied per seat.
    const actions = tableActions(acting(), "100000");
    expect(actions.canDouble).toBe(actions.canAct);
  });

  it("does NOT need cash on hand — the stake is already escrowed", () => {
    // A player who bet their last dollar must still be able to stand.
    expect(tableActions(acting(), "0").canAct).toBe(true);
  });

  it("withdraws everything when it is another seat's turn, and names that seat", () => {
    const actions = tableActions(acting({ turnSeat: 1 }), "100000");
    expect(actions.canAct).toBe(false);
    expect(actions.canDouble).toBe(false);
    // Seats are 0-based on the wire and 1-based on screen.
    expect(actions.reason).toBe("Waiting on seat 2.");
  });

  it("withdraws everything from a seat that sat this hand out", () => {
    const satOut = acting({ seats: [seat(), seat({ seat: 1, username: "Other", wager: MIN })] });
    const actions = tableActions(satOut, "100000");
    expect(actions.canAct).toBe(false);
    expect(actions.canBet).toBe(false);
    expect(actions.reason).toMatch(/sat this hand out/i);
  });

  it("offers nothing while the table has no turn — the hand is mid-deal", () => {
    const actions = tableActions(acting({ turnSeat: null }), "100000");
    expect(actions.canAct).toBe(false);
    expect(actions.reason).toMatch(/being dealt/i);
  });
});

describe("tableActions for a viewer with no seat", () => {
  it("offers nothing to a spectator", () => {
    // `GET /api/casino/table` allows `mySeat: null`; `bet` and `act` both
    // require a seat, so every control is withheld rather than left to 404.
    const actions = tableActions(view({ mySeat: null }), "100000");
    expect(actions).toEqual({
      canBet: false, canAct: false, canDouble: false, reason: actions.reason,
    });
    expect(actions.reason).toMatch(/watching/i);
  });

  it("offers nothing when `mySeat` names a seat that is no longer at the table", () => {
    // The settle frees a `leaving` seat, so a payload read mid-flight can
    // carry a seat number with no row behind it.
    expect(tableActions(view({ mySeat: 4 }), "100000").canBet).toBe(false);
  });
});

describe("the table DTO the helper reads", () => {
  it("parses a live table payload, cards node and all", () => {
    const parsed = CasinoTableResponseSchema.parse({
      table: {
        ...view({ phase: "acting", handNo: 1, turnSeat: 0, deadlineAt: "2026-08-20T15:12:03.114Z" }),
        view: {
          kind: "panel", title: "Blackjack table",
          children: [{ kind: "cards", cards: ["Sa", "B1"] }],
        },
      },
    });
    expect(parsed.table?.turnSeat).toBe(0);
    expect(parsed.table?.deadlineAt).toBe("2026-08-20T15:12:03.114Z");
  });

  it("parses `{ table: null }` — the unseated read, and the read after a settle emptied it", () => {
    expect(CasinoTableResponseSchema.parse({ table: null }).table).toBeNull();
  });

  it("rejects a seat wager sent as a JSON number", () => {
    expect(() => CasinoTableResponseSchema.parse({
      table: { ...view(), seats: [{ ...seat(), wager: 0 }] },
    })).toThrow();
  });
});
