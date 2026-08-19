import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

const key = (token: string): string => `session:${token}`;
const sessionsOf = (playerId: string): string => `playersessions:${playerId}`;

export async function createSession(redis: Redis, playerId: string, ttlSeconds: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(key(token), playerId, "EX", ttlSeconds);
  // Reverse index for destroyAllSessions. Members may outlive their session
  // key (TTL passes, logout of a different device) — consumers tolerate that.
  await redis.sadd(sessionsOf(playerId), token);
  return token;
}

export async function readSession(redis: Redis, token: string): Promise<string | null> {
  return redis.get(key(token));
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  const playerId = await redis.getdel(key(token));
  if (playerId) await redis.srem(sessionsOf(playerId), token);
}

/** Password reset: every device logs out, not just the one that reset. */
export async function destroyAllSessions(redis: Redis, playerId: string): Promise<void> {
  const tokens = await redis.smembers(sessionsOf(playerId));
  if (tokens.length > 0) await redis.del(...tokens.map((t) => key(t)));
  await redis.del(sessionsOf(playerId));
}

const ticketKey = (ticket: string): string => `wsticket:${ticket}`;

/**
 * Short-lived, single-use handshake credential (SPEC §2.2): unlike a session
 * token it is safe to put in a URL, because it dies in ~30s and can only ever
 * be redeemed once — see `consumeTicket`.
 */
export async function createTicket(redis: Redis, playerId: string, ttlSeconds = 30): Promise<string> {
  const ticket = randomBytes(32).toString("base64url");
  await redis.set(ticketKey(ticket), playerId, "EX", ttlSeconds);
  return ticket;
}

/**
 * Atomically reads and deletes the ticket in one round trip (Redis GETDEL,
 * 6.2+) so two simultaneous upgrades presenting the same ticket can't both
 * succeed — a `GET` followed by a separate `DEL` would be a check-then-act
 * race between them.
 */
export async function consumeTicket(redis: Redis, ticket: string): Promise<string | null> {
  return redis.getdel(ticketKey(ticket));
}
