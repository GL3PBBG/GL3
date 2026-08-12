import { describe, expect, it } from "vitest";
import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { keys } from "../src/api/keys.js";
import { invalidationKeys } from "../src/ws/invalidation.js";

const VIEWER = "00000000-0000-7000-8000-000000000002";
const GANG = "00000000-0000-7000-8000-000000000003";

/**
 * Most cases read only `event.type`; the gang ones also read `gangId`, which
 * `extra` supplies. The cast is confined to this helper rather than sprayed
 * over each case.
 */
function event(type: GameEvent["type"], extra: Record<string, unknown> = {}): GameEvent {
  return {
    id: "00000000-0000-7000-8000-000000000000",
    at: "2026-08-08T00:00:00.000Z",
    actorId: "00000000-0000-7000-8000-000000000001",
    actorName: "tester",
    audience: "global",
    type,
    ...extra,
  } as unknown as GameEvent;
}

/** Every type the server can publish, read off the discriminated union. */
const ALL_TYPES = GameEventSchema.options.map((option) => option.shape.type.value);

describe("invalidationKeys", () => {
  it("answers for every event type the server can publish", () => {
    expect(ALL_TYPES.length).toBeGreaterThan(0);
    for (const type of ALL_TYPES) {
      expect(invalidationKeys(event(type, { gangId: GANG }), VIEWER), `no answer for ${type}`)
        .toBeInstanceOf(Array);
    }
  });

  it("refreshes cash, the crime list and jail when a crime resolves", () => {
    // crime.resolved carries jailedUntil, so it is the authoritative jail
    // signal — dropping keys.jail() here is what leaves a jailed player
    // looking free until they navigate.
    expect(invalidationKeys(event("crime.resolved"), VIEWER)).toEqual([
      keys.me(), keys.crimes(), keys.jail(),
    ]);
  });

  it("refreshes the shop's stock after a purchase, not just the wallet", () => {
    expect(invalidationKeys(event("bullets.purchased"), VIEWER)).toEqual([keys.me(), keys.locations()]);
  });

  it("refreshes the wallet and locations on travel", () => {
    expect(invalidationKeys(event("player.travelled"), VIEWER)).toEqual([
      keys.me(), keys.locations(), keys.shop(),
    ]);
  });

  // Stock is per-location and the shop query is not keyed by location, so
  // without this a traveller keeps seeing the city they left.
  it("refreshes the shop on travel", () => {
    expect(invalidationKeys(event("player.travelled"), VIEWER)).toContainEqual(keys.shop());
  });

  it("refreshes only the wallet on a bank transaction", () => {
    expect(invalidationKeys(event("bank.transacted"), VIEWER)).toEqual([keys.me()]);
  });

  it("refreshes jail and crimes on both jail transitions", () => {
    expect(invalidationKeys(event("player.jailed"), VIEWER)).toEqual([keys.jail(), keys.crimes()]);
    expect(invalidationKeys(event("player.released"), VIEWER)).toEqual([keys.jail(), keys.crimes()]);
  });

  it("refreshes the ladder on a rank up", () => {
    expect(invalidationKeys(event("player.rankedUp"), VIEWER)).toEqual([keys.me(), keys.ranks()]);
  });

  it("refreshes the combat surfaces when a shot lands", () => {
    const got = invalidationKeys(
      event("player.attacked", { targetId: "00000000-0000-7000-8000-000000000004", targetName: "B", damage: 12 }),
      VIEWER,
    );
    expect(got).toContainEqual(keys.me());
    expect(got).toContainEqual(keys.combatTargets());
  });

  it("refreshes hospital when someone is killed", () => {
    const got = invalidationKeys(
      event("player.killed", { victimId: "00000000-0000-7000-8000-000000000004", victimName: "B" }),
      VIEWER,
    );
    expect(got).toContainEqual(keys.hospital());
    expect(got).toContainEqual(keys.combatLog());
  });

  // The viewer's gang membership is on their profile, not on /api/auth/me, so
  // a gang event that did not name the profile would leave the Gang page
  // showing the create form to someone who is now in a gang.
  it("refreshes the viewer's profile and the new gang when one is founded", () => {
    expect(invalidationKeys(event("gang.created", { gangId: GANG }), VIEWER)).toEqual([
      keys.profile(VIEWER), keys.gang(GANG),
    ]);
  });

  it("refreshes roster, log, gang and profile on both membership transitions", () => {
    const expected = [
      keys.gangMembers(GANG), keys.gangLogs(GANG), keys.gang(GANG), keys.profile(VIEWER),
    ];
    expect(invalidationKeys(event("gang.memberJoined", { gangId: GANG }), VIEWER)).toEqual(expected);
    expect(invalidationKeys(event("gang.memberLeft", { gangId: GANG }), VIEWER)).toEqual(expected);
  });

  it("keys gang invalidation off the event's gang, not the viewer's", () => {
    const other = "00000000-0000-7000-8000-00000000000f";
    expect(invalidationKeys(event("gang.memberJoined", { gangId: other }), VIEWER))
      .toContainEqual(keys.gangMembers(other));
  });

  it("refreshes the inbox on new mail", () => {
    expect(invalidationKeys(event("mail.received"), VIEWER)).toEqual([keys.mail()]);
  });

  // An invite reaches the invitee as a notification and nothing else — there
  // is no invite event — so this is the only signal the invite list has.
  it("refreshes notifications and gang invites together", () => {
    expect(invalidationKeys(event("notification.created"), VIEWER)).toEqual([
      keys.notifications(), keys.gangInvites(),
    ]);
  });

  it("refreshes the news feed on a post", () => {
    expect(invalidationKeys(event("news.posted"), VIEWER)).toEqual([keys.news()]);
  });

  // Separate from the "no server routes" case below because the reason differs:
  // a plugin event's own keys come from the manifest, which this two-argument
  // call has not supplied — but the manifest itself is still stale, since a
  // plugin can add a page or event after first boot. So it is never empty.
  // The metadata-driven cases live in plugins-invalidation.test.ts.
  it("refreshes the manifest for a plugin.event with no metadata to resolve it", () => {
    expect(invalidationKeys(
      event("plugin.event", { pluginId: "hello", name: "greeted", payload: {} }), VIEWER,
    )).toEqual([keys.plugins()]);
  });

  it("invalidates nothing for surfaces that have no server routes at all", () => {
    for (const type of ["chat.message", "player.joined"] as const) {
      expect(invalidationKeys(event(type), VIEWER)).toEqual([]);
    }
  });

  it("refreshes the bounty list when a bounty is placed", () => {
    expect(invalidationKeys(event("bounty.placed"), VIEWER)).toEqual([keys.bounties()]);
  });

  it("refreshes the bounty list and wallet when a bounty is claimed", () => {
    expect(invalidationKeys(event("bounty.claimed"), VIEWER)).toEqual([
      keys.bounties(), keys.me(),
    ]);
  });

  it("refreshes the oc page and wallet on a heist update", () => {
    expect(invalidationKeys(event("oc.updated"), VIEWER)).toEqual([keys.oc(), keys.me()]);
  });
  it("refreshes the oc page and wallet on a heist resolution", () => {
    expect(invalidationKeys(event("oc.resolved"), VIEWER)).toEqual([keys.oc(), keys.me()]);
  });
});
