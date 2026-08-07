import { desc, eq, lte, sql } from "drizzle-orm";
import { playerStats, ranks } from "../db/schema/index.js";
import { addExp, applyBalanceChange, type Tx } from "./ledger.js";

export interface RankUpResult {
  rankId: string;
  rankName: string;
  cashReward: bigint;
  bulletReward: number;
  maxHealth: number;
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

  return {
    rankId: target.id, rankName: target.name,
    cashReward: target.cashReward, bulletReward: target.bulletReward, maxHealth: target.maxHealth,
  };
}
