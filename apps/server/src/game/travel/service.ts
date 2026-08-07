import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { locations, players, playerStats } from "../../db/schema/index.js";
import { lockPlayersForUpdate, applyBalanceChange } from "../../economy/ledger.js";

export class LocationNotFoundError extends Error {
  constructor(readonly locationId: string) { super(`location not found: ${locationId}`); this.name = "LocationNotFoundError"; }
}
export class AlreadyAtLocationError extends Error {
  constructor(readonly locationId: string) { super(`already at location: ${locationId}`); this.name = "AlreadyAtLocationError"; }
}

export interface TravelResult { locationId: string; cash: string }

/**
 * No randomness, so no worker (M2 plan Decision 1, same reasoning as
 * bank/service.ts) — a `SELECT … FOR UPDATE` on the player's row (via
 * lockPlayersForUpdate) inside one transaction gives the same
 * "no double-travel, no double-debit" guarantee a queue would, and the
 * route layer still gates on the real per-location cooldown with Redis
 * SET NX EX (spec §1.2 locations.L_cooldown) before calling this.
 *
 * Travelling to the player's current location is rejected outright rather
 * than silently no-oped: it costs nothing (spec has no "free re-entry"
 * mechanic), so charging the fare would be a bug, and silently succeeding
 * would hide a client error (stale UI re-submitting the current location).
 * `fromLocationId` is null exactly when player_stats.location_id was NULL —
 * i.e. this is the player's first-ever travel (registration never sets a
 * starting location; only performTravel does).
 */
export async function performTravel(db: Db, redis: Redis, playerId: string, toLocationId: string): Promise<TravelResult> {
  const [destination] = await db.select().from(locations).where(eq(locations.id, toLocationId));
  if (!destination) throw new LocationNotFoundError(toLocationId);

  let fromLocationId: string | null = null;
  await db.transaction(async (tx) => {
    await lockPlayersForUpdate(tx, [playerId]);
    const [current] = await tx.select({ locationId: playerStats.locationId })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    fromLocationId = current?.locationId ?? null;
    if (fromLocationId === toLocationId) throw new AlreadyAtLocationError(toLocationId);

    if (destination.travelCost > 0n) {
      await applyBalanceChange(tx, { playerId, amount: -destination.travelCost, kind: "cash", reason: "travel.cost", refId: destination.id });
    }
    await tx.update(playerStats).set({ locationId: destination.id }).where(eq(playerStats.playerId, playerId));
  });

  const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
  const [fresh] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));

  const event: GameEvent = {
    id: uuidv7(), type: "player.travelled", at: new Date().toISOString(),
    actorId: playerId, actorName: actor?.username ?? "unknown",
    audience: { kind: "player", playerId },
    fromLocationId, toLocationId: destination.id, cost: destination.travelCost.toString(),
  };
  await publishEvent(redis, event);

  return { locationId: destination.id, cash: (fresh?.cash ?? 0n).toString() };
}
