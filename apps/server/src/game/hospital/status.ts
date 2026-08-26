import { and, eq, isNotNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { players, playerStats, ranks } from "../../db/schema/index.js";
import { lockPlayersForUpdate, type Tx } from "../../economy/ledger.js";
import { settleHealth } from "../health-settle.js";

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
 * Publishes no event: this runs inside the caller's transaction, and
 * NOTES.md rule 5 says events are facts, published only after commit.
 *
 * The UPDATE repeats `hospital_until IS NOT NULL` so it is the arbiter of
 * "did THIS call perform the release" — the same shape as jail's
 * `releaseIfExpired`.
 */
export async function settleHospital(tx: Tx, playerId: string): Promise<HospitalStatus> {
  return (await settleHospitalTx(tx, playerId)).status;
}

/**
 * Reports whether THIS call cleared the sentence, which the caller needs to
 * decide whether to publish `player.discharged`. Publishing cannot happen in
 * here: this runs inside the caller's transaction and NOTES.md rule 5 says
 * events are facts, published only after commit.
 */
async function settleHospitalTx(
  tx: Tx, playerId: string,
): Promise<{ status: HospitalStatus; discharged: boolean }> {
  const [row] = await tx.select({
    hospitalUntil: playerStats.hospitalUntil,
    health: playerStats.health,
    healthMax: playerStats.healthMax,
    healthRegenAt: playerStats.healthRegenAt,
  })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!row) return { status: FREE, discharged: false };

  // MCCodes hp regen (audit §1.1, C spec §4.3): ⅓ of max per 5 minutes,
  // lazily, whenever the progression plugin owns the cap — a set health_max.
  // NULL max is rank-derived GL3-native health: untouched, byte-identical.
  // Regen runs even while admitted (MCCodes regenerates always); a discharge
  // below overwrites it with the full restore anyway.
  if (row.healthMax !== null) {
    const settled = settleHealth(row.health, row.healthMax, row.healthRegenAt, new Date());
    if (settled.health !== row.health
        || settled.stamp?.getTime() !== row.healthRegenAt?.getTime()) {
      await tx.update(playerStats)
        .set({ health: settled.health, healthRegenAt: settled.stamp })
        .where(eq(playerStats.playerId, playerId));
    }
  }

  const status = statusFrom(row.hospitalUntil);
  if (status.hospitalised) return { status, discharged: false }; // still admitted
  if (row.hospitalUntil === null) return { status: FREE, discharged: false };

  // The discharge restore fills to the LIVE cap: the progression-owned
  // health_max when set, the rank cap otherwise.
  const maxHealth = row.healthMax ?? await maxHealthFor(tx, playerId);
  const cleared = await tx.update(playerStats)
    .set({ hospitalUntil: null, health: maxHealth })
    .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.hospitalUntil)))
    .returning({ playerId: playerStats.playerId });
  return { status: FREE, discharged: cleared.length > 0 };
}

/**
 * The db-level counterpart of jail's `releaseIfExpired`, and the hospital
 * entry point the sentence sweeper uses.
 *
 * Opens its own transaction and takes the player lock through
 * `lockPlayersForUpdate` — exactly one lock, held alone, which is what makes
 * the sweeper unable to deadlock against combat's two-player ordering
 * (NOTES.md rule 6: a deadlock needs a cycle, and a single-lock holder has
 * no outgoing edge).
 *
 * The event is published after commit (rule 5), and only when the UPDATE
 * matched — so two sweepers, or a sweeper racing a discharge request, publish
 * `player.discharged` exactly once between them.
 */
export async function dischargeIfExpired(
  db: Db, redis: Redis, playerId: string,
): Promise<{ status: HospitalStatus; discharged: boolean }> {
  const [row] = await db.select({ username: players.username })
    .from(players).where(eq(players.id, playerId));
  if (!row) return { status: FREE, discharged: false };

  const outcome = await db.transaction(async (tx) => {
    await lockPlayersForUpdate(tx, [playerId]);
    return settleHospitalTx(tx, playerId);
  });

  if (outcome.discharged) {
    const event: GameEvent = {
      id: uuidv7(),
      type: "player.discharged",
      at: new Date().toISOString(),
      actorId: playerId,
      actorName: row.username,
      audience: { kind: "player", playerId },
    };
    await publishEvent(redis, event);
  }
  return outcome;
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
