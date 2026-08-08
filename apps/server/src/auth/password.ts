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
