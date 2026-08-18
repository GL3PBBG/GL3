import { and, asc, eq } from "drizzle-orm";
import type { PluginTx } from "@gl3/plugin-sdk";
import { shopStock } from "./shop-schema.js";

/**
 * What `itemId` sells for: the caller's own town's listing when one exists,
 * else the cheapest listing anywhere, else null (the item is unstocked
 * game-wide and has no market price). Combat's gunsmith is the consumer —
 * repair pricing follows the local market, the same plugin→plugin helper
 * shape as properties' `ownerAt`.
 *
 * Read-only and unlocked: `p_inventory_shop_stock` has no foreign keys, so
 * this select adds no edge to the lock graph however deep in a caller's
 * transaction it runs. A sold-out listing still carries its price and still
 * counts — scarcity does not make a weapon cheaper to fix.
 */
export async function itemPriceAt(
  tx: PluginTx, itemId: string, locationId: string | null,
): Promise<bigint | null> {
  if (locationId !== null) {
    const [local] = await tx.db
      .select({ price: shopStock.price })
      .from(shopStock)
      .where(and(eq(shopStock.itemId, itemId), eq(shopStock.locationId, locationId)));
    if (local !== undefined) return local.price;
  }
  const [cheapest] = await tx.db
    .select({ price: shopStock.price })
    .from(shopStock)
    .where(eq(shopStock.itemId, itemId))
    .orderBy(asc(shopStock.price))
    .limit(1);
  return cheapest?.price ?? null;
}
