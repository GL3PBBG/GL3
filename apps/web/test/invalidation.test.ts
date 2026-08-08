import { describe, expect, it } from "vitest";
import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { keys } from "../src/api/keys.js";
import { invalidationKeys } from "../src/ws/invalidation.js";

/**
 * invalidationKeys reads only `event.type`, so a fixture needs nothing else.
 * The cast is confined to this helper rather than sprayed over each case.
 */
function event(type: GameEvent["type"]): GameEvent {
  return {
    id: "00000000-0000-7000-8000-000000000000",
    at: "2026-08-08T00:00:00.000Z",
    actorId: "00000000-0000-7000-8000-000000000001",
    actorName: "tester",
    audience: "global",
    type,
  } as unknown as GameEvent;
}

/** Every type the server can publish, read off the discriminated union. */
const ALL_TYPES = GameEventSchema.options.map((option) => option.shape.type.value);

describe("invalidationKeys", () => {
  it("answers for every event type the server can publish", () => {
    expect(ALL_TYPES.length).toBeGreaterThan(0);
    for (const type of ALL_TYPES) {
      expect(invalidationKeys(event(type)), `no answer for ${type}`).toBeInstanceOf(Array);
    }
  });

  it("refreshes cash, the crime list and jail when a crime resolves", () => {
    // crime.resolved carries jailedUntil, so it is the authoritative jail
    // signal — dropping keys.jail() here is what leaves a jailed player
    // looking free until they navigate.
    expect(invalidationKeys(event("crime.resolved"))).toEqual([
      keys.me(), keys.crimes(), keys.jail(),
    ]);
  });

  it("refreshes the shop's stock after a purchase, not just the wallet", () => {
    expect(invalidationKeys(event("bullets.purchased"))).toEqual([keys.me(), keys.locations()]);
  });

  it("refreshes the wallet and locations on travel", () => {
    expect(invalidationKeys(event("player.travelled"))).toEqual([keys.me(), keys.locations()]);
  });

  it("refreshes only the wallet on a bank transaction", () => {
    expect(invalidationKeys(event("bank.transacted"))).toEqual([keys.me()]);
  });

  it("refreshes jail and crimes on both jail transitions", () => {
    expect(invalidationKeys(event("player.jailed"))).toEqual([keys.jail(), keys.crimes()]);
    expect(invalidationKeys(event("player.released"))).toEqual([keys.jail(), keys.crimes()]);
  });

  it("refreshes the ladder on a rank up", () => {
    expect(invalidationKeys(event("player.rankedUp"))).toEqual([keys.me(), keys.ranks()]);
  });

  it("invalidates nothing for Pass 2 surfaces that have no page yet", () => {
    for (const type of ["mail.received", "notification.created", "news.posted", "chat.message"] as const) {
      expect(invalidationKeys(event(type))).toEqual([]);
    }
  });
});
