import { and, eq, isNotNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent, JailStatus } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { lockPlayersForUpdate, type Tx } from "../../economy/ledger.js";
import { playerStats, players } from "../../db/schema/index.js";

const FREE: JailStatus = { jailed: false, until: null, remainingSeconds: 0 };

function statusFrom(jailedUntil: Date | null): JailStatus {
  if (!jailedUntil) return FREE;
  const remainingMs = jailedUntil.getTime() - Date.now();
  if (remainingMs <= 0) return FREE;
  return { jailed: true, until: jailedUntil.toISOString(), remainingSeconds: Math.ceil(remainingMs / 1000) };
}

/** Read-only. Does NOT clear an expired jailed_until — see releaseIfExpired. */
export async function checkJail(db: Db, playerId: string): Promise<JailStatus> {
  const [row] = await db.select({ jailedUntil: playerStats.jailedUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  return statusFrom(row?.jailedUntil ?? null);
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
  db: Db, redis: Redis, playerId: string,
): Promise<{ status: JailStatus; released: boolean }> {
  const [row] = await db.select({ jailedUntil: playerStats.jailedUntil, username: players.username })
    .from(playerStats)
    .innerJoin(players, eq(players.id, playerStats.playerId))
    .where(eq(playerStats.playerId, playerId));
  if (!row) return { status: FREE, released: false };

  const status = statusFrom(row.jailedUntil);
  if (status.jailed) return { status, released: false }; // still serving time
  if (row.jailedUntil === null) return { status: FREE, released: false };

  const cleared = await db.update(playerStats)
    .set({ jailedUntil: null })
    .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.jailedUntil)))
    .returning({ playerId: playerStats.playerId });

  if (cleared.length === 0) return { status: FREE, released: false };

  const event: GameEvent = {
    id: uuidv7(),
    type: "player.released",
    at: new Date().toISOString(),
    actorId: playerId,
    actorName: row.username,
    audience: { kind: "player", playerId },
  };
  await publishEvent(redis, event);
  return { status: FREE, released: true };
}

export async function releaseIfExpired(db: Db, redis: Redis, playerId: string): Promise<JailStatus> {
  return (await releaseIfExpiredWithOutcome(db, redis, playerId)).status;
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
  await tx.update(playerStats).set({ jailedUntil: until }).where(eq(playerStats.playerId, playerId));
  return until;
}
