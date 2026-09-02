import { inArray } from "drizzle-orm";
import type { Redis } from "ioredis";
import { encodeLevelScore, type LeaderboardEntry, type LeaderboardKind } from "@gl3/shared";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";

/**
 * Production reads/writes one global `leaderboard:*` per kind — spec §2.2's
 * design, since every server instance shares one Redis and serves one game.
 * The `prefix` parameter exists ONLY so parallel test files (and the private
 * server each `bootTestServer()` call boots) can get their own namespace on
 * the same shared Redis instance, exactly like `queueName` already does for
 * BullMQ in test/helpers/server.ts. Every caller defaults to this constant,
 * so leaving it unset — as production always does — is a no-op change.
 */
export const DEFAULT_LEADERBOARD_PREFIX = "leaderboard";

const key = (kind: LeaderboardKind, prefix: string): string => `${prefix}:${kind}`;

/** Raw exp when unrouted; level-composite when routed. One writer-side rule. */
export function expScore(level: number, exp: bigint, routed: boolean): bigint {
  return routed ? encodeLevelScore(level, exp) : exp;
}

/**
 * Redis sorted-set scores are IEEE-754 doubles, not arbitrary-precision —
 * safe up to 2^53. V2's real ceiling was 2^31 (spec §1.1); no GL3 economy
 * value gets remotely close to 2^53 within this milestone, so this is a
 * documented bound, not an enforced one.
 */
export async function recordScore(
  redis: Redis, kind: LeaderboardKind, playerId: string, score: bigint, prefix = DEFAULT_LEADERBOARD_PREFIX,
): Promise<void> {
  await redis.zadd(key(kind, prefix), score.toString(), playerId);
}

export async function topN(
  db: Db, redis: Redis, kind: LeaderboardKind, n: number, prefix = DEFAULT_LEADERBOARD_PREFIX,
): Promise<LeaderboardEntry[]> {
  const raw = await redis.zrevrange(key(kind, prefix), 0, n - 1, "WITHSCORES");
  const scored: { playerId: string; score: string }[] = [];
  for (let i = 0; i < raw.length; i += 2) scored.push({ playerId: raw[i]!, score: raw[i + 1]! });
  if (scored.length === 0) return [];

  const rows = await db.select({ id: players.id, username: players.username })
    .from(players).where(inArray(players.id, scored.map((e) => e.playerId)));
  const nameById = new Map(rows.map((r) => [r.id, r.username]));

  return scored.map((entry, i) => ({
    playerId: entry.playerId, username: nameById.get(entry.playerId) ?? "unknown", score: entry.score, rank: i + 1,
  }));
}

/**
 * Idempotent full rebuild from Postgres, run once at boot (spec: "rebuilt
 * from Postgres on boot with an idempotent ZADD sweep"). ZADD on an existing
 * member overwrites its score rather than duplicating it, so calling this
 * any number of times converges to the same state — true within a given
 * `prefix`'s namespace regardless of what other namespaces on the same
 * Redis instance are doing concurrently.
 */
export async function rebuildLeaderboards(
  db: Db, redis: Redis, prefix = DEFAULT_LEADERBOARD_PREFIX, routed = false,
): Promise<void> {
  const rows = await db.select({
    playerId: playerStats.playerId, cash: playerStats.cash, bank: playerStats.bank, exp: playerStats.exp, level: playerStats.level,
  }).from(playerStats);
  if (rows.length === 0) return;

  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.zadd(key("cash", prefix), row.cash.toString(), row.playerId);
    pipeline.zadd(key("bank", prefix), row.bank.toString(), row.playerId);
    pipeline.zadd(key("exp", prefix), expScore(row.level, row.exp, routed).toString(), row.playerId);
  }
  await pipeline.exec();
}
