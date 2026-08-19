import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import {
  issueVerifyToken, consumeVerifyToken, markUnverified, clearUnverified,
  isUnverified, issueResetToken, consumeResetToken,
} from "../src/auth/verify.js";
import { createSession, destroyAllSessions, readSession } from "../src/auth/session.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
afterAll(async () => { await redis.quit(); });

describe("verify tokens", () => {
  it("issues a typeable code and consumes it exactly once, case-insensitively", async () => {
    const playerId = crypto.randomUUID();
    const code = await issueVerifyToken(redis, playerId);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/); // Crockford: no I L O U
    expect(await consumeVerifyToken(redis, code.toLowerCase())).toBe(playerId);
    expect(await consumeVerifyToken(redis, code)).toBeNull(); // single-use
  });
  it("wrong code burns nothing", async () => {
    const playerId = crypto.randomUUID();
    const code = await issueVerifyToken(redis, playerId);
    expect(await consumeVerifyToken(redis, "WRONGWRONG22")).toBeNull();
    expect(await consumeVerifyToken(redis, code)).toBe(playerId);
  });
  it("folds ambiguous Crockford chars: O reads as 0, I and L read as 1", async () => {
    // Written directly to Redis (same key shape `issueVerifyToken` uses)
    // rather than via a generated code: a random 12-char code has close to
    // even odds of containing no 0 or 1 at all, which would make a
    // generated-code version of this test flaky.
    const playerId = crypto.randomUUID();
    const canonicalCode = "AB012CD345E1";
    await redis.set(`emailverify:${canonicalCode}`, playerId, "EX", 60);
    const misTyped = canonicalCode.replace(/0/g, "O").replace(/1/g, "I");
    expect(misTyped).not.toBe(canonicalCode); // the fixture must actually exercise the fold
    expect(await consumeVerifyToken(redis, misTyped)).toBe(playerId);
  });
});

describe("unverified flag", () => {
  it("marks, reads and clears", async () => {
    const playerId = crypto.randomUUID();
    expect(await isUnverified(redis, playerId)).toBe(false);
    await markUnverified(redis, playerId);
    expect(await isUnverified(redis, playerId)).toBe(true);
    await clearUnverified(redis, playerId);
    expect(await isUnverified(redis, playerId)).toBe(false);
  });
});

describe("reset tokens and session teardown", () => {
  it("reset token is single-use", async () => {
    const playerId = crypto.randomUUID();
    const token = await issueResetToken(redis, playerId);
    expect(await consumeResetToken(redis, token)).toBe(playerId);
    expect(await consumeResetToken(redis, token)).toBeNull();
  });
  it("destroyAllSessions kills every session of the player", async () => {
    const playerId = crypto.randomUUID();
    const t1 = await createSession(redis, playerId, 60);
    const t2 = await createSession(redis, playerId, 60);
    await destroyAllSessions(redis, playerId);
    expect(await readSession(redis, t1)).toBeNull();
    expect(await readSession(redis, t2)).toBeNull();
  });
});
