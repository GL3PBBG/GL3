import type { RankDto } from "@gl3/shared";

export interface RankProgress {
  /** Highest rank whose exp requirement this player has met; null below the first rank. */
  current: RankDto | null;
  /** The rank being worked towards; null once the ladder is topped out. */
  next: RankDto | null;
  /** 0–100, progress from `current` to `next`. 100 when there is no next rank. */
  pct: number;
}

/**
 * Where a player sits on the rank ladder.
 *
 * `GET /api/ranks` marks one rank `current` from `player_stats.rank_id`, which
 * the rank-up path writes — but it carries no "exp to next rank", and a
 * brand-new player has `rank_id` null so nothing is flagged at all. Deriving
 * position from `exp` covers both, and agrees with the server flag in the
 * steady state.
 *
 * `ranks` is expected in the server's order (expRequired ascending) but this
 * sorts defensively rather than trusting it — a mis-ordered list would
 * otherwise produce a silently wrong current rank.
 */
export function progressToNextRank(exp: string, ranks: readonly RankDto[]): RankProgress {
  const have = BigInt(exp);
  const ladder = [...ranks].sort((a, b) => (BigInt(a.expRequired) < BigInt(b.expRequired) ? -1 : 1));

  let current: RankDto | null = null;
  let next: RankDto | null = null;
  for (const rank of ladder) {
    if (BigInt(rank.expRequired) <= have) current = rank;
    else { next = rank; break; }
  }

  if (next === null) return { current, next: null, pct: 100 };

  const floor = current === null ? 0n : BigInt(current.expRequired);
  const ceiling = BigInt(next.expRequired);
  const span = ceiling - floor;
  if (span <= 0n) return { current, next, pct: 100 };

  // Percent to two decimals without leaving BigInt until the final divide —
  // exp can exceed 2^53, so (Number(have) / Number(ceiling)) would drift.
  const scaled = ((have - floor) * 10_000n) / span;
  return { current, next, pct: Number(scaled) / 100 };
}
