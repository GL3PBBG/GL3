import { describe, expect, it } from "vitest";
import {
  CasinoLeaveResponseSchema, CasinoLobbyResponseSchema, CasinoRemoteTablesSchema,
  CasinoSitResponseSchema, CasinoTableGameSchema, CasinoTableResponseSchema,
  CasinoTableSeatSchema, CasinoTableSummarySchema, CasinoTableViewSchema,
} from "../src/index.js";

const TABLE_ID = "018f0000-0000-7000-8000-000000000010";
const LOCATION_ID = "018f0000-0000-7000-8000-000000000020";

const SEAT_FIXTURE = {
  seat: 0, playerId: "018f0000-0000-7000-8000-000000000031", username: "Vic",
  wager: "500", leaving: false, idleHands: 0,
};

const TABLE_VIEW_FIXTURE = {
  tableId: TABLE_ID, gameId: "blackjack", gameName: "Blackjack",
  locationId: LOCATION_ID, locationName: "Downtown",
  phase: "acting" as const, handNo: 3,
  deadlineAt: "2026-08-20T12:00:00.000Z", turnSeat: 0, mySeat: 0,
  minBet: "50", maxBet: "5000",
  seats: [SEAT_FIXTURE],
  view: { kind: "text", value: "your move" },
};

describe("casino table DTOs", () => {
  it("parses a table seat", () => {
    expect(CasinoTableSeatSchema.parse(SEAT_FIXTURE).idleHands).toBe(0);
  });

  it("rejects a seat wager sent as a JSON number", () => {
    expect(() => CasinoTableSeatSchema.parse({ ...SEAT_FIXTURE, wager: 500 })).toThrow();
  });

  it("rejects a 5th seat (0-indexed, max 5 seats)", () => {
    expect(() => CasinoTableSeatSchema.parse({ ...SEAT_FIXTURE, seat: 5 })).toThrow();
  });

  it("parses a full table view, with nulls for the pre-clock/spectator cases", () => {
    const parsed = CasinoTableViewSchema.parse(TABLE_VIEW_FIXTURE);
    expect(parsed.phase).toBe("acting");

    const beforeClock = CasinoTableViewSchema.parse({
      ...TABLE_VIEW_FIXTURE, phase: "betting", deadlineAt: null, turnSeat: null,
      mySeat: null, view: null, seats: [],
    });
    expect(beforeClock.deadlineAt).toBeNull();
    expect(beforeClock.view).toBeNull();
  });

  it("parses the table response envelope, table present or absent", () => {
    expect(CasinoTableResponseSchema.parse({ table: TABLE_VIEW_FIXTURE }).table?.tableId).toBe(TABLE_ID);
    expect(CasinoTableResponseSchema.parse({ table: null }).table).toBeNull();
  });

  it("parses sit and leave responses", () => {
    expect(CasinoSitResponseSchema.parse({ tableId: TABLE_ID, seat: 2 }).seat).toBe(2);
    expect(CasinoLeaveResponseSchema.parse({ left: true, deferred: true }).deferred).toBe(true);
    expect(() => CasinoLeaveResponseSchema.parse({ left: false, deferred: false })).toThrow();
  });

  it("parses a table summary and a table game listing", () => {
    const summary = { tableId: TABLE_ID, seatsFilled: 3, maxSeats: 5, phase: "betting" as const };
    expect(CasinoTableSummarySchema.parse(summary).maxSeats).toBe(5);

    const tableGame = {
      gameId: "blackjack", name: "Blackjack", ownerName: null, maxBet: "5000",
      maxSeats: 5, tables: [summary],
    };
    expect(CasinoTableGameSchema.parse(tableGame).tables).toHaveLength(1);
  });

  it("parses a remote-town table row", () => {
    const remote = {
      locationId: LOCATION_ID, locationName: "Uptown", gameId: "blackjack",
      gameName: "Blackjack", seated: 2,
    };
    expect(CasinoRemoteTablesSchema.parse(remote).seated).toBe(2);
  });

  it("parses a lobby response carrying tableGames and remote", () => {
    const lobby = {
      locationId: LOCATION_ID, locationName: "Downtown", minBet: "50",
      games: [],
      tableGames: [{
        gameId: "blackjack", name: "Blackjack", ownerName: null, maxBet: "5000",
        maxSeats: 5, tables: [],
      }],
      remote: [{
        locationId: LOCATION_ID, locationName: "Uptown", gameId: "blackjack",
        gameName: "Blackjack", seated: 1,
      }],
      session: null,
    };
    const parsed = CasinoLobbyResponseSchema.parse(lobby);
    expect(parsed.tableGames).toHaveLength(1);
    expect(parsed.remote).toHaveLength(1);
  });

  it("rejects a lobby response missing tableGames/remote", () => {
    expect(() => CasinoLobbyResponseSchema.parse({
      locationId: LOCATION_ID, locationName: "Downtown", minBet: "50",
      games: [], session: null,
    })).toThrow();
  });
});
