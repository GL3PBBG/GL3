import argon2 from "argon2";
import { createHash, timingSafeEqual } from "node:crypto";

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // A malformed or truncated hash must read as "wrong password", not a 500.
    return false;
  }
}

/**
 * V2 `class/user.php::encrypt()`: sha256(U_id . plaintext).
 * Unsalted beyond the user id, no work factor. SPEC §1.1.
 * The id is concatenated as a *string*, and it is the V2 integer id — not the GL3 uuid.
 */
export function legacyHash(legacyV2Id: number, plaintext: string): string {
  return createHash("sha256").update(`${legacyV2Id}${plaintext}`).digest("hex");
}

export function verifyLegacyPassword(storedHash: string, legacyV2Id: number, plaintext: string): boolean {
  const computed = legacyHash(legacyV2Id, plaintext);
  // MySQL dumps may hold uppercase hex; normalise before comparing.
  const stored = storedHash.trim().toLowerCase();
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(Buffer.from(stored, "utf8"), Buffer.from(computed, "utf8"));
}

/**
 * MCCodes `global_func.php::encode_password()`: md5(pass_salt . md5(password)).
 * An empty/NULL salt means the older unsalted md5(password) form — MCCodes'
 * own login auto-migrated those rows in place (authenticate.php:56-70), so a
 * real dump contains both. Spec 2026-08-26-mccodes-mechanics-audit §7 item 10.
 */
export function legacyMccodesHash(salt: string, plaintext: string): string {
  const inner = createHash("md5").update(plaintext).digest("hex");
  if (salt === "") return inner;
  return createHash("md5").update(salt + inner).digest("hex");
}

export function verifyLegacyMccodesPassword(storedHash: string, salt: string, plaintext: string): boolean {
  const computed = legacyMccodesHash(salt, plaintext);
  // Same dump hygiene as the V2 verifier: uppercase hex, surrounding whitespace.
  const stored = storedHash.trim().toLowerCase();
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(Buffer.from(stored, "utf8"), Buffer.from(computed, "utf8"));
}
