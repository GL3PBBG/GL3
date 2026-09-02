/**
 * Level-score codec for hybrid leaderboards combining player level and within-level exp.
 *
 * Spec §3.4: encodes `(level, exp)` as `level × 1e12 + exp` where exp bounds are
 * validated: within-level exp must stay under (level+1)³ × 2.2 to fit in LEVEL_SCORE_MULTIPLIER.
 * This is safe until level ~7,600; well beyond practical game progression (~level 50–100).
 * The composite always fits under 2^53 for JS Number safety until level ~9,000.
 *
 * Degenerate case: level 0 encodes to raw exp, so unrouted players stay compatible.
 */
export const LEVEL_SCORE_MULTIPLIER = 1_000_000_000_000n;

/**
 * Encode level and within-level exp into a composite score.
 * Returns: `BigInt(level) * LEVEL_SCORE_MULTIPLIER + exp`
 */
export function encodeLevelScore(level: number, exp: bigint): bigint {
  return BigInt(level) * LEVEL_SCORE_MULTIPLIER + exp;
}

/**
 * Decode a composite score back into level and within-level exp.
 * Parses score as BigInt, then returns `{ level, exp }`.
 */
export function decodeLevelScore(score: string): { level: number; exp: bigint } {
  const s = BigInt(score);
  const level = Number(s / LEVEL_SCORE_MULTIPLIER);
  const exp = s % LEVEL_SCORE_MULTIPLIER;
  return { level, exp };
}
