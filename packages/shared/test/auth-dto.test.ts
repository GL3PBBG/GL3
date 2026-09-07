import { describe, expect, it } from "vitest";
import {
  ChangePasswordRequestSchema, DeleteAccountRequestSchema, LegalDocResponseSchema, LegalDocSchema, RegisterRequestSchema,
} from "../src/index.js";

describe("auth request schemas", () => {
  it("register accepts an optional acceptTerms boolean and still parses without it", () => {
    const base = { username: "abc", email: "a@b.co", password: "longenough" };
    expect(RegisterRequestSchema.parse(base).acceptTerms).toBeUndefined();
    expect(RegisterRequestSchema.parse({ ...base, acceptTerms: true }).acceptTerms).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...base, acceptTerms: "yes" }).success).toBe(false);
  });

  it("change password requires an 8+ char new password and a non-empty current one", () => {
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: "x", newPassword: "longenough" }).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: "", newPassword: "longenough" }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: "x", newPassword: "short" }).success).toBe(false);
  });

  it("delete requires a non-empty password", () => {
    expect(DeleteAccountRequestSchema.safeParse({ password: "x" }).success).toBe(true);
    expect(DeleteAccountRequestSchema.safeParse({ password: "" }).success).toBe(false);
  });
});

describe("legal schemas", () => {
  it("names exactly two documents", () => {
    expect(LegalDocSchema.options).toEqual(["terms", "privacy"]);
  });
  it("response carries the missing-placeholder list", () => {
    const parsed = LegalDocResponseSchema.parse({ title: "T", markdown: "# T", effectiveDate: null, missing: ["operatorName"] });
    expect(parsed.missing).toEqual(["operatorName"]);
  });
});
