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

const rankedUp = {
  id: "018f8e2a-0000-7000-8000-000000000010",
  type: "player.rankedUp",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  rankId: "018f8e2a-0000-7000-8000-000000000011",
  rankName: "Soldier",
  cashReward: "500",
  bulletReward: "5",
  maxHealth: 110,
} as const;

const bankTransacted = {
  id: "018f8e2a-0000-7000-8000-000000000012",
  type: "bank.transacted",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  direction: "deposit",
  amount: "100",
  cash: "0",
  bank: "100",
} as const;

const bulletsPurchased = {
  id: "018f8e2a-0000-7000-8000-000000000013",
  type: "bullets.purchased",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  locationId: "018f8e2a-0000-7000-8000-000000000014",
  quantity: 10,
  cost: "50",
  cash: "50",
  bullets: "10",
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

  it("accepts player.rankedUp, bank.transacted, and bullets.purchased (M2)", () => {
    expect(GameEventSchema.parse(rankedUp)).toMatchObject({ type: "player.rankedUp" });
    expect(GameEventSchema.parse(bankTransacted)).toMatchObject({ type: "bank.transacted" });
    expect(GameEventSchema.parse(bulletsPurchased)).toMatchObject({ type: "bullets.purchased" });
  });

  it("covers all nineteen event names after M2's additions", () => {
    expect(new Set(GameEventSchema.options.map((o) => o.shape.type.value))).toEqual(new Set([
      "crime.resolved", "player.jailed", "player.released", "player.travelled",
      "player.attacked", "player.killed", "bounty.placed", "bounty.claimed",
      "gang.created", "gang.memberJoined", "gang.memberLeft", "mail.received",
      "notification.created", "news.posted", "chat.message", "player.joined",
      "player.rankedUp", "bank.transacted", "bullets.purchased",
    ]));
  });

  it("requires player.travelled to carry a cost, and allows a null fromLocationId for a player's first move", () => {
    const travelled = {
      id: "018f8e2a-0000-7000-8000-000000000015",
      type: "player.travelled",
      at: "2026-08-07T00:00:00.000Z",
      actorId: "018f8e2a-0000-7000-8000-000000000002",
      actorName: "Vito",
      audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
      fromLocationId: null,
      toLocationId: "018f8e2a-0000-7000-8000-000000000016",
      cost: "0",
    };
    expect(GameEventSchema.parse(travelled)).toMatchObject({ type: "player.travelled" });
    const { cost: _cost, ...noCost } = travelled;
    expect(() => GameEventSchema.parse(noCost)).toThrow();
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
