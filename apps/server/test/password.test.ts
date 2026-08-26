import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, legacyHash, legacyMccodesHash, verifyLegacyMccodesPassword, verifyLegacyPassword, verifyPassword } from "../src/auth/password.js";

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

  it("concatenates the id as a string prefix, not as a suffix", () => {
    // `42 + "hunter2"` string-coerces to the same "42hunter2" the template
    // literal produces, so numeric-vs-string coercion isn't what this test
    // guards against — it guards against the id landing on the wrong end of
    // the string, e.g. a `plaintext + legacyV2Id` ordering bug.
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

describe("MCCodes legacy passwords (spec 2026-08-26 §7 item 10)", () => {
  // MCCodes global_func.php::encode_password() — md5(pass_salt . md5(plaintext)).
  // authenticate.php auto-migrated older unsalted md5(plaintext) rows in place,
  // so real dumps contain both forms. Hand-computed:
  //   unsalted: node -e 'console.log(require("crypto").createHash("md5").update("hunter2").digest("hex"))'
  //   salted:   md5("abcd1234" + unsalted)
  const unsalted = "2ab96390c7dbe3439de74d0c9b0b1767";
  const salted = "1d4db73bf8b21f9a6e6fa52f6608c87b";
  // md5(unsalted . salt) — the wrong ordering, for the guard below.
  const wrongOrder = "8efef1ea5db821bf57faef9d289fe90b";

  it("reproduces the salted formula: md5(salt . md5(plaintext))", () => {
    expect(legacyMccodesHash("abcd1234", "hunter2")).toBe(salted);
  });

  it("falls back to plain md5(plaintext) for an empty salt (the unsalted form)", () => {
    expect(legacyMccodesHash("", "hunter2")).toBe(unsalted);
    expect(legacyMccodesHash("", "hunter2")).not.toBe(salted);
  });

  it("hashes the salt as a prefix of the inner digest, not as a suffix", () => {
    // Guards against an `md5(inner . salt)` ordering bug.
    expect(legacyMccodesHash("abcd1234", "hunter2")).not.toBe(wrongOrder);
  });

  it("verifies stored hashes in both forms and rejects wrong inputs", () => {
    expect(verifyLegacyMccodesPassword(salted, "abcd1234", "hunter2")).toBe(true);
    expect(verifyLegacyMccodesPassword(unsalted, "", "hunter2")).toBe(true);
    expect(verifyLegacyMccodesPassword(salted, "abcd1234", "wrong")).toBe(false);
    expect(verifyLegacyMccodesPassword(salted, "wrong1", "hunter2")).toBe(false);
    // The unsalted form must NOT verify through the salted formula.
    expect(verifyLegacyMccodesPassword(unsalted, "abcd1234", "hunter2")).toBe(false);
  });

  it("compares case-insensitively against uppercase hex from a MySQL dump", () => {
    expect(verifyLegacyMccodesPassword(salted.toUpperCase(), "abcd1234", "hunter2")).toBe(true);
  });
});
