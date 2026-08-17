import { and, eq, sql } from "drizzle-orm";
import type { PluginTx } from "@gl3/plugin-sdk";
import { propertiesTable, playerStats } from "./schema.js";

export interface PropertyOwnership {
  propertyId: string;
  ownerId: string;
  /**
   * The owner's lever: `cost` when > 0n, else `null`, meaning "the owner
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
 * LOCK ORDER (rule 6). This is order-CONFORMING on its own, not merely
 * order-dependent on the caller: an unlocked pre-read of `owner_player_id`
 * (the same idiom `ownerAt` uses), then `tx.locks.player([ownerId])`, and
 * only then the `FOR UPDATE` re-read that decides who actually gets paid. A
 * caller that touches no other player may call this holding nothing.
 *
 * MUST: a consumer that also acts on a DIFFERENT player in the same
 * transaction (the buyer) MUST resolve the owner (via `ownerAt`) and take
 * both through ONE sorted `tx.locks.player([buyer, ownerId])` call BEFORE
 * calling this or moving any balance. Re-locking an already-held row within
 * one transaction is a no-op re-acquisition, never a wait, so that pre-lock
 * does not conflict with the lock this function takes on its own — but
 * locking the buyer alone and letting THIS function lock the owner
 * afterwards, in its own separate statement, is exactly the ABBA shape that
 * deadlocks against the reverse purchase (owner buying from buyer's own
 * shop at the same moment).
 * Regression: `apps/server/test/properties-consumer-lock-order.test.ts`.
 *
 * TOCTOU. If ownership changes between the unlocked pre-read and the locked
 * re-read (a transfer lands in that gap), the row this function locked is
 * the PRE-read owner's, not the new one's — paying the new owner would move
 * money for a player whose row this call never locked, reopening the exact
 * hole this function exists to close. So it skips the payout instead:
 * `moved` is 0n for this call. The next call against the same property (the
 * new owner's next sale) reads the correct owner and pays them.
 */
export async function payOwner(
  tx: PluginTx, propertyId: string, amount: bigint, reason: string,
): Promise<bigint> {
  if (amount === 0n) return 0n;

  // Unlocked pre-read to learn who to lock, exactly `ownerAt`'s idiom.
  const [pre] = await tx.db
    .select({ ownerPlayerId: propertiesTable.ownerPlayerId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId));
  if (pre === undefined || pre.ownerPlayerId === null) return 0n;

  await tx.locks.player([pre.ownerPlayerId]);

  const [row] = await tx.db
    .select({ id: propertiesTable.id, ownerPlayerId: propertiesTable.ownerPlayerId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId))
    .for("update");
  if (row === undefined || row.ownerPlayerId === null) return 0n;
  // TOCTOU recheck — see the doc comment above.
  if (row.ownerPlayerId !== pre.ownerPlayerId) return 0n;

  const ownerId = row.ownerPlayerId;

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
