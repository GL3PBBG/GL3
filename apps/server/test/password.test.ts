import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, legacyHash, verifyLegacyPassword, verifyPassword } from "../src/auth/password.js";

describe("argon2id passwords", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "hunter2")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword(hash, "hunter3")).toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "hunter2")).toBe(false);
  });
});

describe("V2 legacy passwords (SPEC §1.1 / §4.3)", () => {
  // V2 class/user.php::encrypt() — sha256(U_id . plaintext), unsalted beyond the id.
  // Hand-computed: node -e 'console.log(require("crypto").createHash("sha256").update("42hunter2").digest("hex"))'
  // -> 6fc2187c78d2c3837e882ff859867f97e5216c477cf0971a2dd84b9e0d099f86
  const expected = "6fc2187c78d2c3837e882ff859867f97e5216c477cf0971a2dd84b9e0d099f86";

  it("reproduces the V2 formula: sha256(U_id . plaintext)", () => {
    expect(legacyHash(42, "hunter2")).toBe(expected);
  });

  it("concatenates the id as a string prefix, not as an added number", () => {
    // Guards against a `legacyV2Id + plaintext` numeric-coercion bug.
    expect(legacyHash(42, "hunter2")).not.toBe(createHash("sha256").update("hunter242").digest("hex"));
  });

  it("verifies a stored V2 hash", () => {
    expect(verifyLegacyPassword(expected, 42, "hunter2")).toBe(true);
    expect(verifyLegacyPassword(expected, 42, "wrong")).toBe(false);
    expect(verifyLegacyPassword(expected, 43, "hunter2")).toBe(false);
  });

  it("compares case-insensitively against uppercase hex from a MySQL dump", () => {
    expect(verifyLegacyPassword(expected.toUpperCase(), 42, "hunter2")).toBe(true);
  });
});
