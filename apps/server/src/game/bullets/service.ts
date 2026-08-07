import { eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { locations, players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, lockLocationForUpdate } from "../../economy/ledger.js";

export class NoLocationError extends Error {
  constructor(readonly playerId: string) { super(`player ${playerId} has no location — travel first`); this.name = "NoLocationError"; }
}
export class InsufficientStockError extends Error {
  constructor(readonly locationId: string, readonly available: number) {
    super(`location ${locationId} has only ${available} bullets in stock`);
    this.name = "InsufficientStockError";
  }
}

export interface BulletsPurchaseResult { cash: string; bullets: string; bulletStock: number }

/**
 * Locks the location row before the player's (Global Constraints lock
 * order), so two concurrent buyers at the same location never both read the
 * same stock and both succeed past it.
 */
export async function performBulletsPurchase(db: Db, redis: Redis, playerId: string, quantity: number): Promise<BulletsPurchaseResult> {
  let usedLocationId = "";
  let cost = 0n;

  const result = await db.transaction(async (tx) => {
    const [player] = await tx.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    if (!player?.locationId) throw new NoLocationError(playerId);
    usedLocationId = player.locationId;

    await lockLocationForUpdate(tx, usedLocationId);
    const [location] = await tx.select().from(locations).where(eq(locations.id, usedLocationId));
    if (!location) throw new NoLocationError(playerId); // location was deleted out from under a stale reference
    if (location.bulletStock < quantity) throw new InsufficientStockError(location.id, location.bulletStock);

    cost = location.bulletCost * BigInt(quantity);
    await applyBalanceChange(tx, { playerId, amount: -cost, kind: "cash", reason: "bullets.purchase", refId: location.id });
    await tx.update(locations).set({ bulletStock: location.bulletStock - quantity }).where(eq(locations.id, location.id));
    await tx.update(playerStats).set({ bullets: sql`${playerStats.bullets} + ${quantity}` }).where(eq(playerStats.playerId, playerId));

    const [fresh] = await tx.select({ cash: playerStats.cash, bullets: playerStats.bullets })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    return { cash: fresh!.cash, bullets: fresh!.bullets, bulletStock: location.bulletStock - quantity };
  });

  const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
  const event: GameEvent = {
    id: uuidv7(), type: "bullets.purchased", at: new Date().toISOString(),
    actorId: playerId, actorName: actor?.username ?? "unknown",
    audience: { kind: "player", playerId },
    locationId: usedLocationId, quantity, cost: cost.toString(),
    cash: result.cash.toString(), bullets: result.bullets.toString(),
  };
  await publishEvent(redis, event);

  return { cash: result.cash.toString(), bullets: result.bullets.toString(), bulletStock: result.bulletStock };
}
