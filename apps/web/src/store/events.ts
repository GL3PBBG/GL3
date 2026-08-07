import { useSyncExternalStore } from "react";
import type { GameEvent } from "@gl3/shared";

const MAX_EVENTS = 50;
let events: GameEvent[] = [];
const listeners = new Set<() => void>();

export const eventStore = {
  push(event: GameEvent): void {
    events = [event, ...events].slice(0, MAX_EVENTS);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): GameEvent[] => events,
};

export function useEvents(): GameEvent[] {
  return useSyncExternalStore(eventStore.subscribe, eventStore.snapshot);
}
