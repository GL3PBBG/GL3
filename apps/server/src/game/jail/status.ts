import { and, eq, isNotNull } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { JailStatus } from "@gl3/shared";
import { insertOutboxEvents, type OutboxDelivery } from "../../bus/outbox.js";
import type { Db } from "../../db/client.js";
import { lockPlayersForUpdate, type Tx } from "../../economy/ledger.js";
import { playerStats, players, playerTimers } from "../../db/schema/index.js";
import { superMaxLive, SUPER_MAX_KEY } from "./breakout.js";

const FREE: JailStatus = { jailed: false, until: null, remainingSeconds: 0, superMax: false };

function statusFrom(jailedUntil: Date | null, superMaxUntil: Date | null): JailStatus {
  if (!jailedUntil) return FREE;
  const remainingMs = jailedUntil.getTime() - Date.now();
  if (remainingMs <= 0) return FREE;
  return {
    jailed: true,
    until: jailedUntil.toISOString(),
    remainingSeconds: Math.ceil(remainingMs / 1000),
    superMax: superMaxLive(jailedUntil, superMaxUntil),
  };
}

/**
 * Read-only. Does NOT clear an expired jailed_until — see releaseIfExpired.
 * The super-max lookup only runs when the sentence itself is live — a free
 * player is `superMax: false` without a second query.
 */
export async function checkJail(db: Db, playerId: string): Promise<JailStatus> {
  const [row] = await db.select({ jailedUntil: playerStats.jailedUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  const jailedUntil = row?.jailedUntil ?? null;
  if (jailedUntil === null || jailedUntil.getTime() <= Date.now()) return FREE;

  const [smRow] = await db.select({ expiresAt: playerTimers.expiresAt }).from(playerTimers)
    .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, SUPER_MAX_KEY)));
  return statusFrom(jailedUntil, smRow?.expiresAt ?? null);
}

/**
 * As `releaseIfExpired`, but also reports whether THIS call performed the
 * release. The sentence sweeper needs that answer: it publishes once per
 * genuine claim and counts claims in its tests. Every request path wants the
 * status only, and calls the wrapper below.
 *
 * Postgres is the source of truth for jail (a Redis flush must not free
 * prisoners). This is the ONLY place that clears an expired jailed_until —
 * every gated route calls it first, so release happens lazily on the
 * player's next request instead of needing a cron job.
 *
 * The UPDATE's WHERE clause repeats `jailed_until IS NOT NULL`, so it is the
 * arbiter of "did THIS call actually perform the release": if two requests
 * race past the read above, only the first UPDATE matches a row (`.returning()`
 * is non-empty); the second commits after and matches zero rows, so
 * `player.released` fires exactly once no matter how many requests notice
 * the expiry at once.
 */
export async function releaseIfExpiredWithOutcome(
  db: Db, deliver: OutboxDelivery, playerId: string,
): Promise<{ status: JailStatus; released: boolean }> {
  const [row] = await db.select({ jailedUntil: playerStats.jailedUntil, username: players.username })
    .from(playerStats)
    .innerJoin(players, eq(players.id, playerStats.playerId))
    .where(eq(playerStats.playerId, playerId));
  if (!row) return { status: FREE, released: false };

  const jailedUntil = row.jailedUntil;
  const stillLive = jailedUntil !== null && jailedUntil.getTime() > Date.now();
  if (stillLive) {
    // Super-max lookup only when the sentence is live, same as checkJail.
    const [smRow] = await db.select({ expiresAt: playerTimers.expiresAt }).from(playerTimers)
      .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, SUPER_MAX_KEY)));
    return { status: statusFrom(jailedUntil, smRow?.expiresAt ?? null), released: false }; // still serving time
  }
  if (jailedUntil === null) return { status: FREE, released: false };

  // One transaction for the release AND its outbox row — the event commits
  // with the fact (a bare autocommit UPDATE, the pre-outbox shape, had no
  // transaction to join). The WHERE clause still arbitrates: a racing
  // release blocks on the row lock and then matches zero rows, so
  // `player.released` fires exactly once no matter how many requests notice
  // the expiry at once. A single-row lock held alone cannot form a cycle
  // (rule 6) — the same shape hospital's dischargeIfExpired has always had.
  let outboxRows: { id: string; kind: string; payload: unknown }[] = [];
  await db.transaction(async (tx) => {
    const cleared = await tx.update(playerStats)
      .set({ jailedUntil: null })
      .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.jailedUntil)))
      .returning({ playerId: playerStats.playerId });
    if (cleared.length === 0) return;
    outboxRows = await insertOutboxEvents(tx, [{
      id: uuidv7(),
      type: "player.released",
      at: new Date().toISOString(),
      actorId: playerId,
      actorName: row.username,
      audience: { kind: "player", playerId },
    }]);
  });

  if (outboxRows.length === 0) return { status: FREE, released: false };

  // After commit (rule 5); never throws — the dispatcher owns the retry.
  await deliver(outboxRows);
  return { status: FREE, released: true };
}

export async function releaseIfExpired(db: Db, deliver: OutboxDelivery, playerId: string): Promise<JailStatus> {
  return (await releaseIfExpiredWithOutcome(db, deliver, playerId)).status;
}

/**
 * Called inside the crime worker's transaction (Task 6) — takes `tx`, not `db`.
 *
 * Locks through `lockPlayersForUpdate` first, same as `applyBalanceChange`,
 * for the uniform lock ordering NOTES.md rule 6 requires. In the crime-worker
 * path the lock is already held on this player, so the call is a no-op there
 * — but plugins can reach this as `tx.jail.sendToJail`, and a plugin
 * transaction may touch several players. Without the lock here, a plugin
 * doing `applyBalanceChange(A); sendToJail(B)` can deadlock (`40P01`) against
 * one doing `applyBalanceChange(B); sendToJail(A)` in the opposite order.
 */
export async function sendToJail(tx: Tx, playerId: string, seconds: number): Promise<Date> {
  await lockPlayersForUpdate(tx, [playerId]);
  const until = new Date(Date.now() + seconds * 1000);
  // A fresh sentence starts clean — V2's timer-equality trick naturally
  // diverges on a new jail time; our explicit-timer model needs the explicit
  // delete. Every existing caller (crimes worker, theft chase, oc, bust
  // failure) inherits this with no call-site change.
  await tx.delete(playerTimers)
    .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, SUPER_MAX_KEY)));
  await tx.update(playerStats).set({ jailedUntil: until }).where(eq(playerStats.playerId, playerId));
  return until;
}
