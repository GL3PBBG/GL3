import type { GameEvent } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { pushMessageFor, truncateBody } from "../src/push/message.js";

const ACTOR = "11111111-1111-7111-8111-111111111111";
const OTHER = "22222222-2222-7222-8222-222222222222";
const EVENT_ID = "33333333-3333-7333-8333-333333333333";

const base = {
  id: EVENT_ID,
  at: "2026-09-03T12:00:00.000Z",
  actorId: ACTOR,
  actorName: "Vito",
  audience: { kind: "player", playerId: OTHER } as const,
};

describe("pushMessageFor", () => {
  it("maps mail.received", () => {
    const event: GameEvent = { ...base, type: "mail.received", mailId: EVENT_ID, recipientId: OTHER, subject: "Meet me at the docks" };
    expect(pushMessageFor(event, OTHER)).toEqual({
      title: "New mail from Vito", body: "Meet me at the docks", path: "/mail",
    });
  });

  it("maps notification.created and pushes it to its own actor", () => {
    const event: GameEvent = { ...base, audience: { kind: "player", playerId: ACTOR }, type: "notification.created", notificationId: EVENT_ID, body: "Your car was repaired." };
    expect(pushMessageFor(event, ACTOR)).toEqual({
      title: "Gangster Land", body: "Your car was repaired.", path: "/notifications",
    });
  });

  it("maps player.attacked for the target and skips the attacker", () => {
    const event: GameEvent = { ...base, type: "player.attacked", targetId: OTHER, targetName: "Sal", damage: 17 };
    expect(pushMessageFor(event, OTHER)).toEqual({
      title: "You were attacked", body: "Vito hit you for 17 damage", path: "/plugins/hospital",
    });
    expect(pushMessageFor(event, ACTOR)).toBeNull();
  });

  it("maps player.killed for the victim and skips the killer", () => {
    const event: GameEvent = { ...base, type: "player.killed", victimId: OTHER, victimName: "Sal" };
    expect(pushMessageFor(event, OTHER)).toEqual({
      title: "You were killed", body: "Vito killed you", path: "/plugins/hospital",
    });
    expect(pushMessageFor(event, ACTOR)).toBeNull();
  });

  it("maps bounty.claimed for everyone but the claimer", () => {
    const event: GameEvent = { ...base, type: "bounty.claimed", bountyId: EVENT_ID, targetId: OTHER, targetName: "Sal", amount: "5000" };
    expect(pushMessageFor(event, OTHER)).toEqual({
      title: "Bounty claimed", body: "Vito collected the bounty on Sal for $5000", path: "/plugins/bounties.index",
    });
    expect(pushMessageFor(event, ACTOR)).toBeNull();
  });

  it("maps oc.resolved both ways, including to the leader who fired it", () => {
    const won: GameEvent = { ...base, audience: { kind: "player", playerId: ACTOR }, type: "oc.resolved", heistId: EVENT_ID, success: true, share: "12500", jailSeconds: 0 };
    expect(pushMessageFor(won, ACTOR)).toEqual({
      title: "Heist resolved", body: "The crew got away with $12500", path: "/plugins/oc.index",
    });
    const lost: GameEvent = { ...won, success: false, share: "0", jailSeconds: 600 };
    expect(pushMessageFor(lost, ACTOR)).toEqual({
      title: "Heist resolved", body: "The heist went bad", path: "/plugins/oc.index",
    });
  });

  it("maps gang.memberJoined for the gang and skips the joiner", () => {
    const event: GameEvent = { ...base, audience: { kind: "gang", gangId: EVENT_ID }, type: "gang.memberJoined", gangId: EVENT_ID };
    expect(pushMessageFor(event, OTHER)).toEqual({
      title: "New gang member", body: "Vito joined your gang", path: "/plugins/gangs.index",
    });
    expect(pushMessageFor(event, ACTOR)).toBeNull();
  });

  it("returns null for an unmapped event type", () => {
    const event: GameEvent = { ...base, type: "player.travelled", fromLocationId: null, toLocationId: EVENT_ID, cost: "100" };
    expect(pushMessageFor(event, OTHER)).toBeNull();
  });

  it("truncates a long notification body to 140 characters", () => {
    const long = "word ".repeat(60).trim(); // 299 chars
    const event: GameEvent = { ...base, audience: { kind: "player", playerId: ACTOR }, type: "notification.created", notificationId: EVENT_ID, body: long };
    const message = pushMessageFor(event, ACTOR);
    expect(message).not.toBeNull();
    expect(message!.body.length).toBeLessThanOrEqual(140);
    expect(message!.body.endsWith("…")).toBe(true);
  });
});

describe("truncateBody", () => {
  it("leaves a short body untouched", () => {
    expect(truncateBody("short")).toBe("short");
  });

  it("leaves a body of exactly the limit untouched", () => {
    const exact = "x".repeat(140);
    expect(truncateBody(exact)).toBe(exact);
  });

  it("cuts on a word boundary and appends an ellipsis", () => {
    expect(truncateBody("alpha beta gamma", 12)).toBe("alpha beta…");
  });

  it("cuts mid-word when the window holds no space at all", () => {
    expect(truncateBody("abcdefghijkl", 6)).toBe("abcde…");
  });
});
