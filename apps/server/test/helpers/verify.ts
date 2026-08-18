import type { Redis } from "ioredis";

/**
 * The log mail driver prints the verification code to stdout rather than
 * landing it anywhere a test can read — the code IS the `emailverify:*` key
 * suffix, so tests recover it straight from Redis instead of parsing
 * outbound mail.
 */
export async function verifyCodeFor(redis: Redis, playerId: string): Promise<string> {
  const keys = await redis.keys("emailverify:*");
  for (const key of keys) {
    if ((await redis.get(key)) === playerId) return key.slice("emailverify:".length);
  }
  throw new Error(`no verify token found for player ${playerId}`);
}
