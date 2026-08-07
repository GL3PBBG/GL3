import { inArray } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { LeaderboardEntry, LeaderboardKind } from "@gl3/shared";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";

const key = (kind: LeaderboardKind): string => `leaderboard:${kind}`;

/**
 * Redis sorted-set scores are IEEE-754 doubles, not arbitrary-precision —
 * safe up to 2^53. V2's real ceiling was 2^31 (spec §1.1); no GL3 economy
 * value gets remotely close to 2^53 within this milestone, so this is a
 * documented bound, not an enforced one.
 */
export async function recordScore(redis: Redis, kind: LeaderboardKind, playerId: string, score: bigint): Promise<void> {
  await redis.zadd(key(kind), score.toString(), playerId);
}

export async function topN(db: Db, redis: Redis, kind: LeaderboardKind, n: number): Promise<LeaderboardEntry[]> {
  const raw = await redis.zrevrange(key(kind), 0, n - 1, "WITHSCORES");
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
 * any number of times converges to the same state.
 */
export async function rebuildLeaderboards(db: Db, redis: Redis): Promise<void> {
  const rows = await db.select({ playerId: playerStats.playerId, cash: playerStats.cash, bank: playerStats.bank, exp: playerStats.exp }).from(playerStats);
  if (rows.length === 0) return;

  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.zadd(key("cash"), row.cash.toString(), row.playerId);
    pipeline.zadd(key("bank"), row.bank.toString(), row.playerId);
    pipeline.zadd(key("exp"), row.exp.toString(), row.playerId);
  }
  await pipeline.exec();
}
