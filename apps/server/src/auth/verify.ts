import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Crockford base32 — unambiguous when read from an email and typed back:
 * the generated alphabet omits I, L, O and U, and `consumeVerifyToken`
 * folds a typed-back O to 0 and a typed-back I or L to 1 per the Crockford
 * spec, so a player who reads a generated 0 as an O (or a 1 as an I or L)
 * still verifies.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i]! % 32];
  return code;
}

const verifyKey = (code: string): string => `emailverify:${code}`;
const VERIFY_TTL_SECONDS = 86_400;

export async function issueVerifyToken(redis: Redis, playerId: string): Promise<string> {
  const code = generateCode();
  await redis.set(verifyKey(code), playerId, "EX", VERIFY_TTL_SECONDS);
  return code;
}

/** Crockford decode folding: a typed-back O reads as 0, I and L read as 1. */
function foldAmbiguousChars(code: string): string {
  return code.replace(/O/g, "0").replace(/[IL]/g, "1");
}

/**
 * GETDEL, not GET+compare (rule 2): the token IS the lookup key, so a wrong
 * code deletes nothing and a right one can only ever be redeemed once.
 */
export async function consumeVerifyToken(redis: Redis, code: string): Promise<string | null> {
  const normalized = foldAmbiguousChars(code.trim().toUpperCase());
  if (!/^[0-9A-Z]{1,32}$/.test(normalized)) return null;
  return redis.getdel(verifyKey(normalized));
}

/**
 * Present exactly while a player may not play. No TTL: verification is the
 * only exit. Login re-asserts it from the DB row, so a Redis flush heals on
 * the next login instead of silently unlocking unverified accounts forever.
 */
const unverifiedKey = (playerId: string): string => `unverified:${playerId}`;

export async function markUnverified(redis: Redis, playerId: string): Promise<void> {
  await redis.set(unverifiedKey(playerId), "1");
}
export async function clearUnverified(redis: Redis, playerId: string): Promise<void> {
  await redis.del(unverifiedKey(playerId));
}
export async function isUnverified(redis: Redis, playerId: string): Promise<boolean> {
  return (await redis.exists(unverifiedKey(playerId))) === 1;
}

const resetKey = (token: string): string => `pwreset:${token}`;
const RESET_TTL_SECONDS = 3_600;

export async function issueResetToken(redis: Redis, playerId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(resetKey(token), playerId, "EX", RESET_TTL_SECONDS);
  return token;
}
export async function consumeResetToken(redis: Redis, token: string): Promise<string | null> {
  if (token.length === 0 || token.length > 64) return null;
  return redis.getdel(resetKey(token));
}
