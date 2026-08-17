import { and, eq, sql } from "drizzle-orm";
import type { PluginTx } from "@gl3/plugin-sdk";
import { propertiesTable, playerStats } from "./schema.js";

export interface PropertyOwnership {
  propertyId: string;
  ownerId: string;
  /**
   * The owner's lever: `cost` when non-zero, else `null`, meaning "the owner
   * has not set one — use your own default". V2 does exactly this
   * (`bullets.inc.php:86`: `if (!!$owner["cost"]) $this->setCost(...)`), and
   * it is why the manifest declares no default: bullets' fallback is the
   * location's own `bullet_cost`, which is per-location and admin-editable,
   * and a manifest constant could not express that.
   */
  lever: bigint | null;
}

/**
 * Who owns `pluginId`'s property in `locationId`, or null when nobody does or
 * no such row exists. V2's `Property::getOwnership()`.
 *
 * Read-only and unlocked: a consumer calls this to decide whether to pay
 * anyone at all. `payOwner` re-reads the row FOR UPDATE, so a concurrent
 * transfer between the two calls cannot pay the wrong player.
 */
export async function ownerAt(
  tx: PluginTx, pluginId: string, locationId: string,
): Promise<PropertyOwnership | null> {
  const [row] = await tx.db
    .select({
      id: propertiesTable.id,
      ownerPlayerId: propertiesTable.ownerPlayerId,
      cost: propertiesTable.cost,
    })
    .from(propertiesTable)
    .where(and(eq(propertiesTable.locationId, locationId), eq(propertiesTable.pluginId, pluginId)));
  if (row === undefined || row.ownerPlayerId === null) return null;
  return { propertyId: row.id, ownerId: row.ownerPlayerId, lever: row.cost > 0n ? row.cost : null };
}

/**
 * Credit (`amount > 0`) or debit (`amount < 0`) the property's owner and move
 * `profit` by the amount actually moved. Returns that amount — a debit is
 * clamped to the owner's cash, so `profit` never claims a loss the ledger did
 * not take. Returns 0n when the property is unowned or `amount` is 0n.
 *
 * V2's `Property::updateProfit()` plus the balance write its callers do by
 * hand; folded together here so a consumer cannot move one without the other.
 *
 * LOCK ORDER (rule 6). This takes `tx.locks.player([ownerId])`, which is a
 * no-op if the caller already holds that row. A consumer that also acts on a
 * DIFFERENT player (the buyer) MUST have taken both through ONE
 * `tx.locks.player([buyer, ownerId])` call before calling this — that helper
 * sorts and dedupes, and it is what makes owner-buys-from-own-shop safe
 * against a second player buying at the same moment. Locking the buyer first
 * and letting this take the owner second is an ABBA cycle.
 * Regression: `apps/server/test/properties-consumer-lock-order.test.ts`.
 */
export async function payOwner(
  tx: PluginTx, propertyId: string, amount: bigint, reason: string,
): Promise<bigint> {
  if (amount === 0n) return 0n;

  const [row] = await tx.db
    .select({ id: propertiesTable.id, ownerPlayerId: propertiesTable.ownerPlayerId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId))
    .for("update");
  if (row === undefined || row.ownerPlayerId === null) return 0n;

  const ownerId = row.ownerPlayerId;
  await tx.locks.player([ownerId]);

  let moved = amount;
  if (amount < 0n) {
    // Read under the lock taken above, so two concurrent debits cannot both
    // pass the affordability check.
    const [stats] = await tx.db
      .select({ cash: playerStats.cash })
      .from(playerStats)
      .where(eq(playerStats.playerId, ownerId));
    const cash = stats?.cash ?? 0n;
    const wanted = -amount;
    moved = -(cash < wanted ? cash : wanted);
  }
  if (moved === 0n) return 0n;

  await tx.economy.applyBalanceChange({ playerId: ownerId, amount: moved, kind: "cash", reason });
  await tx.db
    .update(propertiesTable)
    .set({ profit: sql`${propertiesTable.profit} + ${moved}` })
    .where(eq(propertiesTable.id, propertyId));

  return moved;
}
