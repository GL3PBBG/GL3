import { GameEventSchema, type GameEvent } from "@gl3/shared";
import type { Redis } from "ioredis";

export const GAME_EVENTS_CHANNEL = "game:events";

export async function publishEvent(redis: Redis, event: GameEvent): Promise<void> {
  const validated = GameEventSchema.parse(event);
  await redis.publish(GAME_EVENTS_CHANNEL, JSON.stringify(validated));
}
