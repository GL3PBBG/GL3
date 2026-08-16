import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { LeaderboardEntry, LeaderboardKind } from "@gl3/shared";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../economy/ledger.js";
import { players, playerStats, roundEntries } from "../../db/schema/index.js";

const CURRENT = { cash: playerStats.cash, bank: playerStats.bank, exp: playerStats.exp } as const;
const START = { cash: roundEntries.cashAtStart, bank: roundEntries.bankAtStart, exp: roundEntries.expAtStart } as const;
const FINAL = { cash: roundEntries.finalCash, bank: roundEntries.finalBank, exp: roundEntries.finalExp } as const;

/**
 * The ONE ranking statement in this design. No other site writes its own.
 *
 * `exec` is `Db | Tx` because the payout (§2.3 step 2) must rank on the
 * `final_*` values its own transaction froze one statement earlier — under READ
 * COMMITTED a pooled `db` handle cannot see them. `minDelta` appends the
 * `delta > $minDelta` filter the payout needs so a round nobody played pays
 * nobody; both read routes omit it.
 *
 * `ORDER BY delta DESC, player_id ASC` is load-bearing, not cosmetic: the
 * payout ranks with this same statement, so without a total order two players
 * on an identical delta can swap places between the board a player saw and the
 * transaction that paid out.
 *
 * The delta arrives from postgres.js as a JavaScript string (int8 minus int8 is
 * int8, handed back as a string), which is already the wire format MoneySchema
 * wants. Never call Number() on it.
 */
export async function roundStandings(
  exec: Db | Tx,
  roundId: string,
  kind: LeaderboardKind,
  n: number,
  finalized: boolean,
  minDelta?: bigint,
): Promise<LeaderboardEntry[]> {
  // A finalized board reads both operands out of round_entries and therefore
  // does not join player_stats at all — that is what makes it unable to move
  // again. COALESCE covers the one registration that raced the freeze (§2.5):
  // it scores 0 rather than sorting to the top as a NULL would.
  const delta = finalized
    ? sql<string>`(coalesce(${FINAL[kind]}, ${START[kind]}) - ${START[kind]})`
    : sql<string>`(${CURRENT[kind]} - ${START[kind]})`;

  const where = minDelta === undefined
    ? eq(roundEntries.roundId, roundId)
    : and(eq(roundEntries.roundId, roundId), sql`${delta} > ${minDelta.toString()}::bigint`);

  const scored = finalized
    ? await exec.select({ playerId: roundEntries.playerId, delta })
        .from(roundEntries)
        .where(where)
        .orderBy(desc(delta), asc(roundEntries.playerId))
        .limit(n)
    : await exec.select({ playerId: roundEntries.playerId, delta })
        .from(roundEntries)
        .innerJoin(playerStats, eq(playerStats.playerId, roundEntries.playerId))
        .where(where)
        .orderBy(desc(delta), asc(roundEntries.playerId))
        .limit(n);

  if (scored.length === 0) return [];

  // Second query, byte-identical to what topN already does, so the "unknown"
  // fallback behaves the same on a round board and the all-time board.
  const rows = await exec.select({ id: players.id, username: players.username })
    .from(players).where(inArray(players.id, scored.map((e) => e.playerId)));
  const nameById = new Map(rows.map((r) => [r.id, r.username]));

  return scored.map((entry, i) => ({
    playerId: entry.playerId,
    username: nameById.get(entry.playerId) ?? "unknown",
    score: entry.delta,
    rank: i + 1,
  }));
}
