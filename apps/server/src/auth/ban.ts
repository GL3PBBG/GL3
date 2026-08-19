import type { Redis } from "ioredis";

/**
 * Redis is a cache of the ban gate, the players row is the truth — the same
 * split `verify.ts` uses for the unverified gate. A flushed flag re-asserts at
 * the next login; a timed ban's flag carries the remaining TTL so expiry
 * self-heals with no cron and no check-then-act (rule 2: the TTL is set in the
 * same SET that creates the flag).
 */
const bannedKey = (playerId: string): string => `banned:${playerId}`;

export async function markBanned(redis: Redis, playerId: string, expiresAt: Date | null): Promise<void> {
  if (expiresAt === null) { await redis.set(bannedKey(playerId), "1"); return; }
  const ttlSeconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
  // Already expired: setting a flag with no TTL would ban forever.
  if (ttlSeconds <= 0) return;
  await redis.set(bannedKey(playerId), "1", "EX", ttlSeconds);
}

export async function clearBanned(redis: Redis, playerId: string): Promise<void> {
  await redis.del(bannedKey(playerId));
}

export async function isBanned(redis: Redis, playerId: string): Promise<boolean> {
  return (await redis.exists(bannedKey(playerId))) === 1;
}
