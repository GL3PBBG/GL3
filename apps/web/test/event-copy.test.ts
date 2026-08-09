import type { EventMeta, GameEvent } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/lib/eventCopy.js";

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
});
