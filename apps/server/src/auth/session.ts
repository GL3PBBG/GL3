import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

const key = (token: string): string => `session:${token}`;

export async function createSession(redis: Redis, playerId: string, ttlSeconds: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(key(token), playerId, "EX", ttlSeconds);
  return token;
}

export async function readSession(redis: Redis, token: string): Promise<string | null> {
  return redis.get(key(token));
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  await redis.del(key(token));
}
