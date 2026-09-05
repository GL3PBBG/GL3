import { describe, expect, it } from "vitest";
import { GameEventSchema, MoneySchema, ServerFrameSchema } from "../src/index.js";
import { AttackRequestSchema, AttackResponseSchema, WeaponConditionDtoSchema } from "../src/dto/combat.js";
import { ProfileDtoSchema } from "../src/dto/profile.js";
import { RankListResponseSchema } from "../src/dto/rank.js";

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

const pluginEvent = {
  id: "018f8e2a-0000-7000-8000-000000000020",
  type: "plugin.event",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "global" },
  pluginId: "bounties",
  name: "placed",
  payload: { target: "Ron", amount: "50000" },
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

  // M5 adds exactly one name — the envelope every plugin event travels in. The
  // core names stay closed: a ported core module gets its own variant,
  // not a plugin.event, so this census failing is how an accidental widening of
  // the core union is caught. The backfire/weapon-condition spec added one more
  // core variant, player.backfired (attacker-only weapon jam). The rounds spec
  // adds two more, round.started and round.finished — rounds are core (no
  // relinquish migration), so they join this list rather than travelling as
  // plugin.event. The progression plugin (C3) adds player.levelUp — the
  // MCCodes ladder's counterpart to rankedUp, fired only on a routed boot.
  it("covers the core event names plus M5's plugin envelope, plus player.backfired and rounds", () => {
    expect(new Set(GameEventSchema.options.map((o) => o.shape.type.value))).toEqual(new Set([
      "crime.resolved", "player.jailed", "player.released", "player.travelled",
      "player.attacked", "player.killed", "player.backfired", "player.discharged", "bounty.placed", "bounty.claimed",
      "gang.created", "gang.memberJoined", "gang.memberLeft", "mail.received",
      "notification.created", "news.posted", "chat.message", "player.joined",
      "player.rankedUp", "player.levelUp", "bank.transacted", "bullets.purchased",
      "oc.updated", "oc.resolved",
      "round.started", "round.finished",
      "plugin.event",
    ]));
  });

  it("accepts a plugin.event envelope and round-trips its payload", () => {
    expect(GameEventSchema.parse(pluginEvent)).toMatchObject({
      type: "plugin.event", pluginId: "bounties", name: "placed",
    });
    expect(GameEventSchema.parse(JSON.parse(JSON.stringify(pluginEvent)))).toEqual(pluginEvent);
  });

  // The envelope is deliberately open about *what* is in the payload — the
  // plugin's own declared schema is what checks that — but it is not open about
  // the envelope's own fields, which the client reads to route and render.
  it("requires pluginId and name on the envelope, and a payload object", () => {
    const { pluginId: _p, ...noPluginId } = pluginEvent;
    expect(() => GameEventSchema.parse(noPluginId)).toThrow();
    const { name: _n, ...noName } = pluginEvent;
    expect(() => GameEventSchema.parse(noName)).toThrow();
    expect(() => GameEventSchema.parse({ ...pluginEvent, payload: "not an object" })).toThrow();
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

describe("backfire and condition contracts", () => {
  it("parses a player.backfired event", () => {
    const parsed = GameEventSchema.parse({
      id: "018f0000-0000-7000-8000-000000000001",
      at: new Date().toISOString(),
      actorId: "018f0000-0000-7000-8000-000000000002",
      actorName: "shooter",
      audience: { kind: "player", playerId: "018f0000-0000-7000-8000-000000000002" },
      type: "player.backfired",
      selfDamage: 7,
      hospitalised: false,
    });
    expect(parsed.type).toBe("player.backfired");
  });

  it("rejects a negative selfDamage", () => {
    expect(() => GameEventSchema.parse({
      id: "018f0000-0000-7000-8000-000000000001",
      at: new Date().toISOString(),
      actorId: "018f0000-0000-7000-8000-000000000002",
      actorName: "shooter",
      audience: { kind: "player", playerId: "018f0000-0000-7000-8000-000000000002" },
      type: "player.backfired",
      selfDamage: -1,
      hospitalised: false,
    })).toThrow();
  });

  it("requires the three new attack response fields", () => {
    expect(() => AttackResponseSchema.parse({
      hit: false, crit: false, damage: 0, armorAbsorbed: 0,
      targetHealth: 100, targetKilled: false, payout: "0", bulletsSpent: 1,
    })).toThrow();
  });

  it("parses a weapon condition dto with no weapon equipped", () => {
    const dto = WeaponConditionDtoSchema.parse({
      itemId: null, name: null, condition: 100, backfireChance: 0, repairCost: "0",
      firearm: null, melee: null, fists: null,
    });
    expect(dto.itemId).toBeNull();
    expect(dto.melee).toBeNull();
  });

  it("parses fists described as a melee model", () => {
    const dto = WeaponConditionDtoSchema.parse({
      itemId: null, name: null, condition: 100, backfireChance: 0, repairCost: "0",
      firearm: null, melee: null, fists: { power: 1, strength: "40", estimate: "60" },
    });
    expect(dto.fists?.estimate).toBe("60");
  });

  it("parses a weapon condition dto with a melee slot armed and slot 1 empty", () => {
    const dto = WeaponConditionDtoSchema.parse({
      itemId: null, name: null, condition: 100, backfireChance: 0, repairCost: "0",
      firearm: null, fists: null,
      melee: { itemId: "018f0000-0000-7000-8000-00000000000a", name: "Bat", power: 12, strength: "40", estimate: "720" },
    });
    expect(dto.melee?.estimate).toBe("720");
  });

  it("parses an attack response naming the weapon that fired", () => {
    const dto = AttackResponseSchema.parse({
      hit: true, crit: false, damage: 10, armorAbsorbed: 0, targetHealth: 90, targetKilled: false,
      payout: "0", bulletsSpent: 0, backfire: false, selfDamage: 0, attackerHealth: 100,
      weapon: "melee", weaponName: "Bat",
    });
    expect(dto.weapon).toBe("melee");
    expect(AttackRequestSchema.parse({ weapon: "firearm" }).weapon).toBe("firearm");
    expect(AttackRequestSchema.safeParse({ weapon: "bazooka" }).success).toBe(false);
  });

  it("carries a nullable money rank label on a profile", () => {
    const dto = ProfileDtoSchema.parse({
      playerId: "018f0000-0000-7000-8000-000000000002",
      username: "someone", bio: null, avatarUrl: null,
      gangId: null, gangName: null, exp: "0", rankName: null,
      moneyRankLabel: null, backfire: 0,
      createdAt: new Date().toISOString(),
    });
    expect(dto.moneyRankLabel).toBeNull();
  });

  it("carries a money rank ladder on the rank list", () => {
    const res = RankListResponseSchema.parse({
      ranks: [],
      moneyRanks: [{ id: "018f0000-0000-7000-8000-000000000003", label: "Broke", threshold: "0" }],
    });
    expect(res.moneyRanks[0]?.label).toBe("Broke");
  });
});
