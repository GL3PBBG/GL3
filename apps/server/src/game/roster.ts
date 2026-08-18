import { and, asc, eq, gt, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { players, playerStats, ranks } from "../db/schema/index.js";

export type Facility = "hospital" | "jail";

export interface RosterEntry {
  playerId: string;
  username: string;
  rankName: string;
  until: string;
  remainingSeconds: number;
}

/** Mirrors `ranks.max_health`'s own fallback shape: a player may have no rank row. */
const UNRANKED = "Unranked";

/**
 * Everyone serving a live sentence in the caller's own town, caller excluded.
 *
 * Read-only by design — it settles nothing. An elapsed sentence is filtered
 * out by the `> now()` predicate and left for the sweeper or the sentenced
 * player's own next request; a roster read must never take write locks on
 * strangers, which is what would happen if it called `settleHospital` per row.
 *
 * A caller standing nowhere (`location_id IS NULL`) sees an empty list rather
 * than an error — a fresh account before its first travel is in that state.
 */
export async function listSentencedAtLocation(
  db: Db, viewerId: string, facility: Facility,
): Promise<RosterEntry[]> {
  const [viewer] = await db.select({ locationId: playerStats.locationId })
    .from(playerStats).where(eq(playerStats.playerId, viewerId));
  const locationId = viewer?.locationId ?? null;
  if (locationId === null) return [];

  const column = facility === "hospital" ? playerStats.hospitalUntil : playerStats.jailedUntil;
  const now = new Date();

  const rows = await db.select({
    playerId: playerStats.playerId,
    username: players.username,
    rankName: ranks.name,
    until: column,
  })
    .from(playerStats)
    .innerJoin(players, eq(players.id, playerStats.playerId))
    .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
    .where(and(
      eq(playerStats.locationId, locationId),
      ne(playerStats.playerId, viewerId),
      gt(column, now),
    ))
    .orderBy(asc(column));

  return rows.map((row) => ({
    playerId: row.playerId,
    username: row.username,
    rankName: row.rankName ?? UNRANKED,
    // Non-null: the `gt(column, now)` predicate above already excludes null rows.
    until: (row.until as Date).toISOString(),
    remainingSeconds: Math.max(0, Math.ceil(((row.until as Date).getTime() - Date.now()) / 1000)),
  }));
}
