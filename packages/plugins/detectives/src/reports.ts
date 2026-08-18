import { and, eq, gt, lte } from "drizzle-orm";
import type { PluginTx } from "@gl3/plugin-sdk";
import { detectiveSearches } from "./schema.js";

/**
 * Every player the hirer currently holds a LIVE report on: succeeded, past
 * ends_at (the reveal), before expires_at (the licence window). A NULL
 * expires_at (pre-upgrade row) fails `gt` and counts as expired — combat
 * never honours a report whose window was never stamped.
 *
 * Read-only and lock-free by design: combat calls this inside its attack
 * transaction, and a plain SELECT adds no edge to the lock graph.
 */
export async function activeReportTargetIds(
  tx: PluginTx, hirerId: string, now: Date,
): Promise<Set<string>> {
  const rows = await tx.db
    .select({ targetId: detectiveSearches.targetPlayerId })
    .from(detectiveSearches)
    .where(and(
      eq(detectiveSearches.playerId, hirerId),
      eq(detectiveSearches.succeeded, true),
      lte(detectiveSearches.endsAt, now),
      gt(detectiveSearches.expiresAt, now),
    ));
  return new Set(rows.map((r) => r.targetId));
}
