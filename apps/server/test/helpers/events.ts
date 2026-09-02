import { GameEventSchema, type GameEvent } from "@gl3/shared";
import type { Redis } from "ioredis";
import { GAME_EVENTS_CHANNEL } from "../../src/bus/publish.js";

/**
 * Waits for the next `game:events` pub/sub message whose `actorId` matches
 * `actorId`, ignoring everything else.
 *
 * `game:events` is a single global channel shared by every test file running
 * in parallel — a bare `subscriber.once("message", ...)` resolves on
 * whichever file's event lands first, so a test can intermittently receive
 * and assert against a stranger's payload (see travel.test.ts's flake
 * writeup). Every frame is parsed with `GameEventSchema.safeParse` and only
 * one naming this test's own actor settles the promise. Bounded by
 * `timeoutMs` so a genuinely missing event fails the test instead of hanging
 * the run.
 */
export function awaitOwnEvent(subscriber: Redis, actorId: string, timeoutMs = 5000): Promise<GameEvent> {
  return new Promise((resolve, reject) => {
    const onMessage = (channel: string, raw: string): void => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.actorId !== actorId) return;
      clearTimeout(timer);
      subscriber.off("message", onMessage);
      resolve(parsed.data);
    };
    const timer = setTimeout(() => {
      subscriber.off("message", onMessage);
      reject(new Error(`awaitOwnEvent: no event for actorId ${actorId} within ${timeoutMs}ms`));
    }, timeoutMs);
    subscriber.on("message", onMessage);
  });
}

type PluginEnvelope = Extract<GameEvent, { type: "plugin.event" }>;

/**
 * `awaitOwnEvent` for one specific plugin event. The actor filter alone is
 * not enough when the transaction under test also notifies: `tx.notify`
 * publishes a `notification.created` naming the SAME actor, and whichever
 * envelope the outbox delivers first would settle `awaitOwnEvent` — a test
 * asserting on the plugin event would then flake on delivery order.
 */
export function awaitOwnPluginEvent(
  subscriber: Redis, actorId: string, pluginId: string, name: string, timeoutMs = 5000,
): Promise<PluginEnvelope> {
  return new Promise((resolve, reject) => {
    const onMessage = (channel: string, raw: string): void => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.actorId !== actorId) return;
      const event = parsed.data;
      if (event.type !== "plugin.event" || event.pluginId !== pluginId || event.name !== name) return;
      clearTimeout(timer);
      subscriber.off("message", onMessage);
      resolve(event);
    };
    const timer = setTimeout(() => {
      subscriber.off("message", onMessage);
      reject(new Error(`awaitOwnPluginEvent: no ${pluginId}.${name} for actorId ${actorId} within ${timeoutMs}ms`));
    }, timeoutMs);
    subscriber.on("message", onMessage);
  });
}
