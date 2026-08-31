import { randomInt } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Anti-bot layer 2 (spec 2026-08-31-anti-bot-design): an admin-set flag that
 * 409s every MUTATING request until the player answers a human check. No TTL
 * on the flag — solving (or an admin clearing it) is the only exit. The
 * stored answer is consumed by GETDEL (rule 2): a wrong attempt burns the
 * question, so an answer can never be brute-forced against one stored value,
 * and two racing submits cannot both pass.
 *
 * The arithmetic is deliberately trivial for a HUMAN — its value is friction
 * plus an audit signal (the admin watches whether behavior changes once
 * flagged), not a Turing test; a bot author who codes around it has still
 * revealed themselves in the ledger stats that got them flagged.
 */
export const challengeFlagKey = (playerId: string): string => `challenge:required:${playerId}`;
export const challengeQuestionKey = (playerId: string): string => `challenge:q:${playerId}`;

export async function isChallenged(redis: Redis, playerId: string): Promise<boolean> {
  return (await redis.exists(challengeFlagKey(playerId))) === 1;
}

export async function setChallenged(redis: Redis, playerId: string): Promise<void> {
  await redis.set(challengeFlagKey(playerId), "1");
}

export async function clearChallenged(redis: Redis, playerId: string): Promise<void> {
  await redis.del(challengeFlagKey(playerId), challengeQuestionKey(playerId));
}

/** Mints (and stores the answer for) a fresh question; overwrites any prior one. */
export async function mintQuestion(redis: Redis, playerId: string): Promise<string> {
  const a = randomInt(2, 50);
  const b = randomInt(2, 50);
  // EX 600: an abandoned question must not live forever, and the client can
  // always GET a fresh one.
  await redis.set(challengeQuestionKey(playerId), String(a + b), "EX", 600);
  return `What is ${a} + ${b}?`;
}

/** True = solved and unflagged. False = wrong or stale; the question is burnt either way. */
export async function answerChallenge(redis: Redis, playerId: string, answer: string): Promise<boolean> {
  const stored = await redis.getdel(challengeQuestionKey(playerId));
  if (stored === null || stored !== answer.trim()) return false;
  await redis.del(challengeFlagKey(playerId));
  return true;
}
