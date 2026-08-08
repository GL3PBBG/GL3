import { GameEventSchema, type GameEvent } from "@gl3/shared";
import type { Redis } from "ioredis";
import { GAME_EVENTS_CHANNEL } from "./publish.js";

export type EventHandler = (event: GameEvent) => void;

/** Requires a client created with `createSubscriber` — a subscribed client runs no other commands. */
export async function subscribeToEvents(subscriber: Redis, handler: EventHandler): Promise<void> {
  await subscriber.subscribe(GAME_EVENTS_CHANNEL);
  subscriber.on("message", (channel, raw) => {
    if (channel !== GAME_EVENTS_CHANNEL) return;
    const parsed = GameEventSchema.safeParse(JSON.parse(raw));
    // A malformed frame from another instance must not take this process down.
    if (parsed.success) handler(parsed.data);
  });
}
