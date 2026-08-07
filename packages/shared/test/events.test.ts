import { describe, expect, it } from "vitest";
import { GameEventSchema, MoneySchema, ServerFrameSchema } from "../src/index.js";

const crimeResolved = {
  id: "018f8e2a-0000-7000-8000-000000000001",
  type: "crime.resolved",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  crimeId: "018f8e2a-0000-7000-8000-000000000003",
  crimeName: "Pickpocket",
  success: true,
  payout: "250",
  bullets: "0",
  exp: "5",
  jailedUntil: null,
} as const;

describe("GameEventSchema", () => {
  it("accepts a crime.resolved event", () => {
    expect(GameEventSchema.parse(crimeResolved)).toMatchObject({ type: "crime.resolved" });
  });

  it("survives a JSON round-trip through the bus", () => {
    const wire = JSON.stringify(crimeResolved);
    expect(GameEventSchema.parse(JSON.parse(wire))).toEqual(crimeResolved);
  });

  it("rejects an unknown event type", () => {
    expect(() => GameEventSchema.parse({ ...crimeResolved, type: "crime.exploded" })).toThrow();
  });

  it("requires the acting player's id and display name on every event (SPEC §3)", () => {
    const { actorId: _id, ...noActorId } = crimeResolved;
    expect(() => GameEventSchema.parse(noActorId)).toThrow();
    const { actorName: _name, ...noActorName } = crimeResolved;
    expect(() => GameEventSchema.parse(noActorName)).toThrow();
  });

  it("covers all sixteen event names listed in SPEC §3", () => {
    expect(new Set(GameEventSchema.options.map((o) => o.shape.type.value))).toEqual(new Set([
      "crime.resolved", "player.jailed", "player.released", "player.travelled",
      "player.attacked", "player.killed", "bounty.placed", "bounty.claimed",
      "gang.created", "gang.memberJoined", "gang.memberLeft", "mail.received",
      "notification.created", "news.posted", "chat.message", "player.joined",
    ]));
  });

  it("rejects a payout that is not an integer string", () => {
    expect(() => MoneySchema.parse("250.5")).toThrow();
    expect(() => MoneySchema.parse(250)).toThrow();
    expect(MoneySchema.parse("-250")).toBe("-250");
  });

  it("wraps events in a server frame", () => {
    const frame = ServerFrameSchema.parse({ kind: "event", event: crimeResolved });
    expect(frame.kind).toBe("event");
  });
});
