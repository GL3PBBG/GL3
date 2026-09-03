import { useSyncExternalStore } from "react";
import type { EventMeta, GameEvent } from "@gl3/shared";
import { isSilentEvent } from "../lib/eventCopy.js";

const MAX_EVENTS = 50;
let events: GameEvent[] = [];
const listeners = new Set<() => void>();

export const eventStore = {
  push(event: GameEvent): void {
    // The crime worker's queue is at-least-once: a retried job re-publishes the
    // same event id, and without this the player sees one crime twice.
    if (events.some((existing) => existing.id === event.id)) return;
    events = [event, ...events].slice(0, MAX_EVENTS);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): GameEvent[] => events,
};

/**
 * The socket's way in, and the ONLY one that knows about silence.
 *
 * The store is a 50-entry ring buffer, so filtering a silent event at RENDER
 * time is not enough: it would still take a slot and push a real fact out the
 * back. Two hands at a full table is ~100 ticks, which is the whole buffer —
 * the feed would read "Nothing yet" while a crime, a kill and a bounty were
 * silently evicted behind it. A silent event must therefore never be STORED.
 *
 * A separate function rather than a check inside `push` because `push` is the
 * dedupe-and-notify primitive and has no business knowing what a manifest is;
 * this is also what makes the rule testable without a DOM (`@gl3/web` is a
 * node-only project — `EventFeed.tsx` is not reachable from a test).
 */
export function recordEvent(event: GameEvent, eventMetas: readonly EventMeta[]): void {
  if (isSilentEvent(event, eventMetas)) return;
  eventStore.push(event);
}

export function useEvents(): GameEvent[] {
  return useSyncExternalStore(eventStore.subscribe, eventStore.snapshot);
}
