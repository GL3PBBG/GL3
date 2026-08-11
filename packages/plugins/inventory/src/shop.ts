import { InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { readEffects } from "./effects.js";
import { items, playerItems, playerStats } from "./schema.js";
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

/**
 * Published to the buyer alone. A purchase is private — the same audience
 * `bullets.purchased` uses.
 *
 * A plugin event, not `publishCore`: none of the 19 core `GameEvent` variants
 * covers a shop purchase, and adding one to `@gl3/shared` for one plugin's
 * feature is a core schema change this does not need.
 */
export const purchasedEvent = {
  name: "purchased",
  payload: z.object({
    itemId: z.string().uuid(),
    name: z.string(),
    qty: z.number().int(),
    cost: z.string(),
  }),
  describe: "Bought {qty}x {name}",
  // Web query-key prefixes the client drops when this arrives: the inventory
  // listing (a new item) and `me` (cash moved).
  invalidates: ["inventory", "me"],
};

const BuySchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const shopBuyRoute = route({
  method: "POST",
  path: "/api/shop/buy",
  // Buying is an action. Both gates are answered by the loader with a 423
  // before this handler runs.
  accessInJail: false,
  accessInHospital: false,
  body: BuySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Step 1, unlocked, and that is safe: a `travel` off this location must
      // hold the row step 2 takes in order to commit, so it cannot slip in
      // between. Reading it under the player lock instead would invert the
      // location -> player order (CLAUDE.md rule 6).
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId ?? null;
      if (locationId === null) throw new PluginError("no_location", 409);

      // LOCATION FIRST, and this line must stay first. `applyBalanceChange`
      // below is what acquires `player_stats` — it locks internally — so no
      // explicit player lock appears here to hint at the ordering.
      await tx.locks.location(locationId);

      const [row] = await tx.db
        .select({ price: shopStock.price, stock: shopStock.stock, name: items.name })
        .from(shopStock)
        .innerJoin(items, eq(items.id, shopStock.itemId))
        .where(and(eq(shopStock.locationId, locationId), eq(shopStock.itemId, body.itemId)));
      if (!row) throw new PluginError("not_sold_here", 409);
      if (row.stock < body.quantity) {
        throw new PluginError("insufficient_stock", 409, { available: row.stock });
      }

      const cost = row.price * BigInt(body.quantity);

      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -cost,
          kind: "cash",
          reason: "shop.purchase",
          refId: body.itemId,
        });
      } catch (error) {
        // The loader maps only PluginError; without this an overdraft is a 500.
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_funds", 409);
        }
        throw error;
      }

      // `stock >= quantity` in the WHERE is the guard, not the read above.
      // Under the location lock the read is already authoritative; the
      // predicate is what makes the statement correct rather than merely
      // currently-serialised. Zero rows back means insufficient_stock.
      const decremented = await tx.db
        .update(shopStock)
        .set({ stock: sql`${shopStock.stock} - ${body.quantity}` })
        .where(and(
          eq(shopStock.locationId, locationId),
          eq(shopStock.itemId, body.itemId),
          gte(shopStock.stock, body.quantity),
        ))
        .returning({ stock: shopStock.stock });
      const remainingStock = decremented[0]?.stock;
      if (remainingStock === undefined) {
        throw new PluginError("insufficient_stock", 409, { available: row.stock });
      }

      // FKs checked (rule 6): `player_items` references `players` and `items`,
      // so this takes FOR KEY SHARE on one row of each. Nothing in the codebase
      // locks either table FOR UPDATE — the only FOR UPDATE sites are
      // `player_stats`, `locations` and `gangs` — so this adds no lock edge and
      // no new lock pair.
      const [owned] = await tx.db
        .insert(playerItems)
        .values({ playerId: player.id, itemId: body.itemId, qty: body.quantity })
        .onConflictDoUpdate({
          target: [playerItems.playerId, playerItems.itemId],
          set: { qty: sql`${playerItems.qty} + ${body.quantity}` },
        })
        .returning({ qty: playerItems.qty });

      await tx.events.publish({
        name: "purchased",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: {
          itemId: body.itemId,
          name: row.name,
          qty: body.quantity,
          cost: cost.toString(),
        },
      });

      return {
        status: 200,
        body: {
          cash: cash.toString(),
          itemId: body.itemId,
          qty: owned?.qty ?? body.quantity,
          stock: remainingStock,
        },
      };
    });
  },
});
