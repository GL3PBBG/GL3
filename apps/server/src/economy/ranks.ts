import { asc, desc, eq, lte, sql } from "drizzle-orm";
import { playerStats, ranks } from "../db/schema/index.js";
import { addExp, applyBalanceChange, type Tx } from "./ledger.js";

export interface RankUpResult {
  rankId: string;
  rankName: string;
  cashReward: bigint;
  bulletReward: number;
  maxHealth: number;
}

/** A row of the `ranks` table, as selected in ladder order. */
type RankRow = typeof ranks.$inferSelect;

/**
 * Pays a rank's cash and bullet rewards to a player — the shared tail of
 * both `applyExpAndRankUp` and `syncRankToLevel`. Caller must already hold
 * the player row (same contract both callers already document).
 */
async function payRankReward(tx: Tx, playerId: string, target: RankRow): Promise<void> {
  if (target.cashReward > 0n) {
    await applyBalanceChange(tx, {
      playerId, amount: target.cashReward, kind: "cash", reason: "rank.reward", refId: target.id,
    });
  }
  if (target.bulletReward > 0) {
    await tx.update(playerStats)
      .set({ bullets: sql`${playerStats.bullets} + ${target.bulletReward}` })
      .where(eq(playerStats.playerId, playerId));
  }
}

/**
 * Adds exp, then promotes the player to the highest rank their new total
 * exp now qualifies for (spec §1.2 ranks.R_exp threshold). A single large
 * exp grant can cross more than one threshold at once — this grants only
 * the destination rank's own reward, not every skipped rung's. Skipped
 * ranks were never actually held, so their rewards were never "earned" in
 * the legacy sense either; paying out every intervening rung would let one
 * big exp award (e.g. an admin grant) mint a multiple of any single
 * promotion's cash, which is exactly the kind of unbounded payout the
 * ledger invariant is meant to rule out. Returns the promotion details on
 * a fresh promotion, or null when nothing changed (no exp gained, or
 * already at the qualifying rank). Must run inside the caller's
 * transaction, same contract as addExp.
 */
export async function applyExpAndRankUp(tx: Tx, playerId: string, expGain: bigint): Promise<RankUpResult | null> {
  await addExp(tx, playerId, expGain);
  if (expGain === 0n) return null;

  const [current] = await tx.select({ exp: playerStats.exp, rankId: playerStats.rankId })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!current) return null;

  const [target] = await tx.select().from(ranks)
    .where(lte(ranks.expRequired, current.exp))
    .orderBy(desc(ranks.expRequired))
    .limit(1);
  if (!target || target.id === current.rankId) return null;

  await tx.update(playerStats).set({
    rankId: target.id,
    health: target.maxHealth, // V2: a rank-up raises the health ceiling (R_health)
  }).where(eq(playerStats.playerId, playerId));

  await payRankReward(tx, playerId, target);

  return {
    rankId: target.id, rankName: target.name,
    cashReward: target.cashReward, bulletReward: target.bulletReward, maxHealth: target.maxHealth,
  };
}

/**
 * Reconciles `player_stats.rank_id` to the rank the player's current
 * `level` ordinally maps to (spec §3.1), for boots whose exp is routed
 * through a level-based plugin rather than GL3-native exp thresholds.
 *
 * The ladder is ordered by `exp_required` ascending — that ordinal order,
 * not the exp values themselves, is what a level maps onto: position
 * `min(level, count) - 1`. A NULL stored `rankId` (an MCCodes import the
 * sync has never touched) reads as position -1, below every rung.
 *
 * Writes `rank_id` ONLY — never `health`, unlike `applyExpAndRankUp`, whose
 * health-ceiling bump is a GL3-native rank mechanic that has no bearing on
 * a level-routed boot. When `opts.pay` is true AND the target's ladder
 * position is above the stored rank's position, pays the destination
 * rank's rewards (same `payRankReward` both functions share) and returns
 * the `RankUpResult`. Otherwise — `pay` false, or the move is a
 * demotion-shaped stamp (stored position above target, only possible via
 * admin edits) — the row is stamped and this returns null.
 *
 * Must run inside the caller's transaction, player row already locked by
 * the caller (`tx.locks.player` — same contract `applyExpAndRankUp` states).
 */
export async function syncRankToLevel(
  tx: Tx, playerId: string, opts: { pay: boolean },
): Promise<RankUpResult | null> {
  const [current] = await tx.select({ level: playerStats.level, rankId: playerStats.rankId })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!current || current.level <= 0) return null;

  const ladder = await tx.select().from(ranks).orderBy(asc(ranks.expRequired));
  if (ladder.length === 0) return null;

  const targetPosition = Math.min(current.level, ladder.length) - 1;
  const target = ladder[targetPosition] as RankRow;
  if (target.id === current.rankId) return null;

  const storedPosition = current.rankId === null
    ? -1
    : ladder.findIndex((r) => r.id === current.rankId);
  const promoting = targetPosition > storedPosition;

  await tx.update(playerStats).set({ rankId: target.id }).where(eq(playerStats.playerId, playerId));

  if (!promoting || !opts.pay) return null;

  await payRankReward(tx, playerId, target);

  return {
    rankId: target.id, rankName: target.name,
    cashReward: target.cashReward, bulletReward: target.bulletReward, maxHealth: target.maxHealth,
  };
}
