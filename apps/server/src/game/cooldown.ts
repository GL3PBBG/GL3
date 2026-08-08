import type { Redis } from "ioredis";

export function cooldownKey(playerId: string, action: string): string {
  return `cooldown:${action}:${playerId}`;
}

/**
 * Atomically claim a cooldown. Returns true only for the caller that won it.
 * Long timers (jail, hospital) additionally live in Postgres columns so a Redis
 * flush cannot free prisoners — see spec §2.2.
 */
export async function acquireCooldown(redis: Redis, key: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

/** Seconds remaining, or 0 when the cooldown is free. */
export async function peekCooldown(redis: Redis, key: string): Promise<number> {
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : 0;
}

/** Compensating action: call this when an enqueue fails after acquiring. */
export async function releaseCooldown(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}
