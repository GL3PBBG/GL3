import type { EventMeta, GameEvent } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { eventStore, recordEvent } from "../src/store/events.js";

/**
 * The feed's store is a fixed-size ring buffer, which is why silence has to be
 * enforced HERE and not only at render time. A silent event that is stored and
 * then hidden still takes a slot and pushes a real fact out the back: casino's
 * table tick fires once per seat per transition, so two hands at a full table
 * is roughly the whole buffer, and the feed would read empty while a crime, a
 * kill and a bounty were evicted behind it.
 *
 * The store is module-level state shared by every case in this file, so each
 * one uses its own event ids and asserts against `snapshot()` by id rather
 * than by length.
 */
const metas: EventMeta[] = [
  {
    pluginId: "casino", name: "table", describe: "{actorName} is at the tables",
    invalidates: ["casino"], silent: true,
  },
  {
    pluginId: "bounties", name: "placed", describe: "{actorName} placed a bounty",
    invalidates: ["bounties"],
  },
];

/** The envelope fields every event carries; the cast is confined here, as in
 *  `event-copy.test.ts` and `invalidation.test.ts`. */
function pluginEvent(id: string, pluginId: string, name: string): GameEvent {
  return {
    id,
    at: "2026-08-21T00:00:00.000Z",
    actorId: "00000000-0000-7000-8000-000000000001",
    actorName: "Ron",
    audience: { kind: "player", playerId: "00000000-0000-7000-8000-000000000001" },
    type: "plugin.event",
    pluginId,
    name,
    payload: {},
  } as unknown as GameEvent;
}

const idsInStore = (): string[] => eventStore.snapshot().map((e) => e.id);

describe("recordEvent", () => {
  it("keeps a silent event out of the store entirely", () => {
    recordEvent(pluginEvent("silent-1", "casino", "table"), metas);
    expect(idsInStore()).not.toContain("silent-1");
  });

  it("stores an event whose meta says nothing about silence", () => {
    recordEvent(pluginEvent("loud-1", "bounties", "placed"), metas);
    expect(idsInStore()).toContain("loud-1");
  });

  it("stores a plugin event this client has no metadata for", () => {
    // Not silent, because it cannot be known to be: a manifest that predates
    // the declaration renders the event rather than hiding a real fact.
    recordEvent(pluginEvent("unknown-1", "casino", "table"), []);
    expect(idsInStore()).toContain("unknown-1");
  });

  it("stores core events, which have no meta to consult", () => {
    const core = {
      id: "core-1", at: "2026-08-21T00:00:00.000Z",
      actorId: "00000000-0000-7000-8000-000000000001", actorName: "Ron",
      audience: { kind: "global" }, type: "player.released",
    } as unknown as GameEvent;
    recordEvent(core, metas);
    expect(idsInStore()).toContain("core-1");
  });

  // The eviction property itself, and the reason the guard is not at render
  // time: a run of ticks longer than the buffer must not cost a single real
  // event its slot.
  it("does not evict a stored event no matter how many ticks arrive", () => {
    recordEvent(pluginEvent("keeper", "bounties", "placed"), metas);
    for (let i = 0; i < 60; i += 1) {
      recordEvent(pluginEvent(`flood-${i}`, "casino", "table"), metas);
    }
    expect(idsInStore()).toContain("keeper");
  });
});
