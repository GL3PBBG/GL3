import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { playerStats, ranks } from "../../db/schema/index.js";
import { lockPlayersForUpdate, type Tx } from "../../economy/ledger.js";

export interface HospitalStatus {
  hospitalised: boolean;
  until: string | null;
  remainingSeconds: number;
}

const FREE: HospitalStatus = { hospitalised: false, until: null, remainingSeconds: 0 };

/** Default when a player has no rank row — mirrors `ranks.max_health`'s own default. */
const DEFAULT_MAX_HEALTH = 100;

function statusFrom(hospitalUntil: Date | null): HospitalStatus {
  if (!hospitalUntil) return FREE;
  const remainingMs = hospitalUntil.getTime() - Date.now();
  if (remainingMs <= 0) return FREE;
  return {
    hospitalised: true,
    until: hospitalUntil.toISOString(),
    remainingSeconds: Math.ceil(remainingMs / 1000),
  };
}

/** Read-only. Does NOT clear an elapsed sentence — see settleHospital. */
export async function checkHospital(db: Db, playerId: string): Promise<HospitalStatus> {
  const [row] = await db.select({ hospitalUntil: playerStats.hospitalUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  return statusFrom(row?.hospitalUntil ?? null);
}

/** The player's rank cap, or 100 when `rank_id` is null. */
export async function maxHealthFor(tx: Tx, playerId: string): Promise<number> {
  const [row] = await tx.select({ maxHealth: ranks.maxHealth })
    .from(playerStats)
    .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
    .where(eq(playerStats.playerId, playerId));
  return row?.maxHealth ?? DEFAULT_MAX_HEALTH;
}

/**
 * The ONLY place an elapsed `hospital_until` is cleared, and it restores
 * health at the same time.
 *
 * Lazy-on-read is not good enough here, unlike jail: a player whose sentence
 * elapsed still has `health = 0` in the row until something touches them, so
 * they could be attacked at 0 health and instantly re-killed. Combat calls
 * this for BOTH participants immediately after taking the player locks, so
 * the restore cannot race the attack that reads its result.
 *
 * Takes `tx`, not `db`: every caller is already inside a transaction that
 * holds the relevant player lock.
 *
 * Publishes no event. `GameEventSchema` has `player.released` for jail but no
 * hospital equivalent, and adding a core variant is an SDK surface change
 * (`CoreEventInput` is derived from `GameEvent`) this feature does not need.
 *
 * The UPDATE repeats `hospital_until IS NOT NULL` so it is the arbiter of
 * "did THIS call perform the release" — the same shape as jail's
 * `releaseIfExpired`.
 */
export async function settleHospital(tx: Tx, playerId: string): Promise<HospitalStatus> {
  const [row] = await tx.select({ hospitalUntil: playerStats.hospitalUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!row) return FREE;

  const status = statusFrom(row.hospitalUntil);
  if (status.hospitalised) return status; // still admitted
  if (row.hospitalUntil === null) return FREE;

  const maxHealth = await maxHealthFor(tx, playerId);
  await tx.update(playerStats)
    .set({ hospitalUntil: null, health: maxHealth })
    .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.hospitalUntil)));
  return FREE;
}

/**
 * Locks through `lockPlayersForUpdate` first, same as `applyBalanceChange`
 * and `sendToJail`, for the uniform ordering NOTES.md rule 6 requires. A
 * combat transaction already holds this lock, so the call is a no-op there —
 * but plugins reach this as `tx.hospital.sendToHospital` and a plugin
 * transaction may touch several players.
 */
export async function sendToHospital(tx: Tx, playerId: string, seconds: number): Promise<Date> {
  await lockPlayersForUpdate(tx, [playerId]);
  const until = new Date(Date.now() + seconds * 1000);
  await tx.update(playerStats)
    .set({ hospitalUntil: until, health: 0 })
    .where(eq(playerStats.playerId, playerId));
  return until;
}
