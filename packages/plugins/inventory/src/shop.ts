import { PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt } from "drizzle-orm";
import { readEffects } from "./effects.js";
import { items, playerStats } from "./schema.js";
import { shopStock } from "./shop-schema.js";

/**
 * Stock at the caller's current location.
 *
 * No jail or hospital gate — both default open in the SDK and are left that
 * way deliberately: browsing is not an action.
 */
export const shopListRoute = route({
  method: "GET",
  path: "/api/shop",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId ?? null;
      // Same answer POST /api/bullets/buy gives a player who is nowhere.
      if (locationId === null) throw new PluginError("no_location", 409);

      // INNER join to `items`: the stock table has no FKs (see shop-schema.ts),
      // so a deleted item leaves an orphan row. The join is what keeps it
      // invisible to players.
      const rows = await tx.db
        .select({
          itemId: items.id,
          name: items.name,
          itemType: items.itemType,
          effects: items.effects,
          price: shopStock.price,
          stock: shopStock.stock,
        })
        .from(shopStock)
        .innerJoin(items, eq(items.id, shopStock.itemId))
        .where(and(eq(shopStock.locationId, locationId), gt(shopStock.stock, 0)));

      return {
        status: 200,
        body: {
          locationId,
          items: rows.map((row) => ({
            itemId: row.itemId,
            name: row.name,
            itemType: row.itemType,
            // Through the same readEffects the inventory listing uses, so a
            // shop row shows the numbers combat will actually use.
            effects: readEffects(row.itemType, row.effects),
            // Money crosses the wire as a decimal string, never a JSON number.
            price: row.price.toString(),
            stock: row.stock,
          })),
        },
      };
    });
  },
});
