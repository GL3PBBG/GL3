import type { EventMeta, GameEvent } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { describeEvent, isSilentEvent } from "../src/lib/eventCopy.js";

const metas: EventMeta[] = [{
  pluginId: "hello", name: "greeted",
  describe: "{actorName} greeted {target} {count} times", invalidates: ["hello"],
}];

/**
 * The envelope fields every event carries. Payload-bearing cases spread their
 * own on top; the cast is confined here rather than repeated per case, as in
 * invalidation.test.ts.
 */
function event(extra: Record<string, unknown>): GameEvent {
  return {
    id: "00000000-0000-7000-8000-000000000000",
    at: "2026-08-08T00:00:00.000Z",
    actorId: "00000000-0000-7000-8000-000000000001",
    actorName: "Ron",
    audience: "global",
    ...extra,
  } as unknown as GameEvent;
}

function pluginEvent(extra: Record<string, unknown> = {}): GameEvent {
  return event({
    type: "plugin.event", pluginId: "hello", name: "greeted",
    payload: { target: "Vic", count: "3" }, ...extra,
  });
}

describe("describeEvent", () => {
  // Pins the extraction itself: the core switch moved out of EventFeed.tsx
  // unchanged, formatMoney included.
  it("renders a core event from its own fields", () => {
    const crime = event({
      type: "crime.resolved", crimeName: "Pickpocket", success: true,
      payout: "1500", exp: "12", bullets: "0", jailedUntil: null,
      crimeId: "00000000-0000-7000-8000-000000000009",
    });
    expect(describeEvent(crime)).toBe("Pickpocket: succeeded, +$1,500 (+12 exp)");
  });

  it("names the bullet reward on a successful crime that paid one", () => {
    const crime = event({
      type: "crime.resolved", crimeName: "Armoured Van", success: true,
      payout: "4000", exp: "40", bullets: "3", jailedUntil: null,
      crimeId: "00000000-0000-7000-8000-000000000009",
    });
    expect(describeEvent(crime)).toBe("Armoured Van: succeeded, +$4,000 (+40 exp, +3 bullets)");
  });

  it("distinguishes a pool-shortfall no-attempt from a failed roll", () => {
    const shortfall = event({
      type: "crime.resolved", crimeName: "Pickpocket", success: false,
      cause: "insufficient_pool",
      payout: "0", exp: "0", bullets: "0", jailedUntil: null,
      crimeId: "00000000-0000-7000-8000-000000000009",
    });
    expect(describeEvent(shortfall)).toBe("Pickpocket: called off — you couldn't cover the cost");
    const failed = event({
      type: "crime.resolved", crimeName: "Pickpocket", success: false,
      payout: "0", exp: "0", bullets: "0", jailedUntil: null,
      crimeId: "00000000-0000-7000-8000-000000000009",
    });
    expect(describeEvent(failed)).toBe("Pickpocket: failed");
  });

  it("renders a plugin event through its manifest template", () => {
    expect(describeEvent(pluginEvent(), metas)).toBe("Ron greeted Vic 3 times");
  });

  it("falls back to the envelope's own fields when no metadata matches", () => {
    expect(describeEvent(pluginEvent({ pluginId: "unknown" }), metas))
      .toBe("Ron: unknown.greeted");
  });

  // The match is on (pluginId, name), not name alone — two plugins may each
  // declare a "greeted", and rendering one's template for the other's event
  // would put the wrong plugin's words in the feed.
  it("does not match a same-named event from a different plugin", () => {
    const metasOther: EventMeta[] = [{ ...metas[0], pluginId: "other" }];
    expect(describeEvent(pluginEvent(), metasOther)).toBe("Ron: hello.greeted");
  });

  // The other half of the same predicate. A plugin declaring both "greeted"
  // and "insulted" must not get the first meta's template for the second
  // event: that renders confidently wrong copy with no error anywhere.
  it("does not match a different event from the same plugin", () => {
    expect(describeEvent(pluginEvent({ name: "insulted" }), metas))
      .toBe("Ron: hello.insulted");
  });

  // Security property: `payload` is z.record(z.unknown()) and may carry
  // player-supplied strings, so the envelope's authoritative actorName has to
  // win. If the spread ran the other way this renders "Mallory greeted ...".
  it("does not let a payload's own actorName shadow the envelope's", () => {
    const spoofed = pluginEvent({ payload: { target: "Vic", count: "3", actorName: "Mallory" } });
    expect(describeEvent(spoofed, metas)).toBe("Ron greeted Vic 3 times");
  });

  it("describes a hospital discharge", () => {
    expect(describeEvent(event({
      id: "01920000-0000-7000-8000-000000000003",
      type: "player.discharged",
      at: "2026-08-14T00:00:00.000Z",
      actorId: "01920000-0000-7000-8000-0000000000aa",
      actorName: "tester",
      audience: { kind: "player", playerId: "01920000-0000-7000-8000-0000000000aa" },
    })))
      .toBe("Discharged from hospital");
  });

  // Second person, and the target is never named: the event reaches the
  // attacker alone, and the shot never reached anyone else.
  it("describes a backfire in the second person", () => {
    expect(describeEvent(event({
      type: "player.backfired", selfDamage: 12, hospitalised: false,
    }))).toBe("Your weapon backfired for 12");
  });

  it("says so when the backfire hospitalised the shooter", () => {
    expect(describeEvent(event({
      type: "player.backfired", selfDamage: 40, hospitalised: true,
    }))).toBe("Your weapon backfired for 40 — hospitalised");
  });

  it("announces a round starting", () => {
    expect(describeEvent(event({
      type: "round.started", roundId: "00000000-0000-7000-8000-000000000010",
      roundName: "Summer 2026", endsAt: null,
    }))).toBe("Round Summer 2026 has started");
  });

  it("names the first-place winner when a round finishes", () => {
    expect(describeEvent(event({
      type: "round.finished", roundId: "00000000-0000-7000-8000-000000000010",
      roundName: "Summer 2026",
      winners: [{ playerId: "00000000-0000-7000-8000-000000000011", username: "alice", placing: 1, points: "1000" }],
    }))).toBe("Round Summer 2026 has finished — alice took first");
  });

  it("falls back to a plain finish message when there are no winners", () => {
    expect(describeEvent(event({
      type: "round.finished", roundId: "00000000-0000-7000-8000-000000000010",
      roundName: "Summer 2026", winners: [],
    }))).toBe("Round Summer 2026 has finished");
  });
});

/**
 * The render-time half of the silent-event flag: `describeEvent` still words
 * a silent event (an old client, or a caller that renders one deliberately),
 * and `isSilentEvent` is what EventFeed consults to skip the line entirely.
 *
 * The unknown-meta case is the one that matters most. A client whose cached
 * manifest predates the declaration cannot know the event is silent, so it
 * renders it — noisy, and the only alternative would be hiding events the
 * client knows nothing about, which is how a real fact goes missing.
 */
describe("isSilentEvent", () => {
  const silentMetas: EventMeta[] = [{
    pluginId: "casino", name: "table", describe: "{actorName} is at the tables",
    invalidates: ["casino"], silent: true,
  }];

  it("is true for a plugin event whose meta declares silence", () => {
    expect(isSilentEvent(pluginEvent({ pluginId: "casino", name: "table" }), silentMetas)).toBe(true);
  });

  it("is false for a plugin event whose meta says nothing about silence", () => {
    expect(isSilentEvent(pluginEvent(), metas)).toBe(false);
  });

  it("is false for a meta that declares silent: false", () => {
    const loud: EventMeta[] = [{ ...silentMetas[0]!, silent: false }];
    expect(isSilentEvent(pluginEvent({ pluginId: "casino", name: "table" }), loud)).toBe(false);
  });

  it("is false when no meta matches — an unknown event still renders", () => {
    expect(isSilentEvent(pluginEvent({ pluginId: "casino", name: "table" }), metas)).toBe(false);
    expect(isSilentEvent(pluginEvent(), [])).toBe(false);
  });

  // Same (pluginId, name) pairing describeEvent uses: two plugins may each
  // declare a "table", and one's silence must not mute the other's.
  it("does not take silence from a same-named event of another plugin", () => {
    const other: EventMeta[] = [{ ...silentMetas[0]!, pluginId: "other" }];
    expect(isSilentEvent(pluginEvent({ pluginId: "casino", name: "table" }), other)).toBe(false);
  });

  it("is false for every core event, which has no meta to consult", () => {
    expect(isSilentEvent(event({ type: "player.released" }), silentMetas)).toBe(false);
  });
});
