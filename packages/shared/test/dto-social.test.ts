import { describe, expect, it } from "vitest";
import {
  RegisterRequestSchema, VerifyRequestSchema, ForgotRequestSchema,
  ResetRequestSchema, OnlineListResponseSchema, CreateTopicRequestSchema,
  CreatePostRequestSchema,
} from "../src/index.js";

describe("social cluster DTOs", () => {
  it("register requires email and rejects NUL bytes", () => {
    expect(RegisterRequestSchema.safeParse({ username: "abc", password: "12345678" }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ username: "abc", email: `a${String.fromCharCode(0)}b@x.com`, password: "12345678" }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ username: "abc", email: "a@x.com", password: "12345678" }).success).toBe(true);
  });
  it("verify code is bounded and NUL-guarded", () => {
    expect(VerifyRequestSchema.safeParse({ code: "ABCD2345EFGH" }).success).toBe(true);
    expect(VerifyRequestSchema.safeParse({ code: "" }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ code: "x".repeat(64) }).success).toBe(false);
  });
  it("forgot/reset shapes", () => {
    expect(ForgotRequestSchema.safeParse({ email: "a@x.com" }).success).toBe(true);
    expect(ResetRequestSchema.safeParse({ token: "t".repeat(12), password: "12345678" }).success).toBe(true);
    expect(ResetRequestSchema.safeParse({ token: "t".repeat(12), password: "short" }).success).toBe(false);
  });
  it("online list entries allow null location", () => {
    const ok = OnlineListResponseSchema.safeParse({
      onlineNow: [{ playerId: "0198c5b1-0000-7000-8000-000000000001", username: "a", locationName: null, lastActiveAt: new Date().toISOString() }],
      lastHour: [],
    });
    expect(ok.success).toBe(true);
  });
  it("forum bodies enforce V2 minimums", () => {
    expect(CreateTopicRequestSchema.safeParse({ subject: "hi", body: "too short? no — subject is" }).success).toBe(false);
    expect(CreateTopicRequestSchema.safeParse({ subject: "subject", body: "long enough body" }).success).toBe(true);
    expect(CreatePostRequestSchema.safeParse({ body: "short" }).success).toBe(false);
    expect(CreatePostRequestSchema.safeParse({ body: "long enough" }).success).toBe(true);
  });
});
