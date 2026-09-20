import type { PluginTx } from "@gl3/plugin-sdk";
import { InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { readEffects } from "./effects.js";
import { items, playerItems, playerStats } from "./schema.js";
import { shopStock } from "./shop-schema.js";

interface StockRow {
  itemId: string; name: string; itemType: string; effects: unknown; price: bigint; stock: number;
}

/** The caller's town and its sellable stock (stock > 0, orphan rows hidden by the `items` join). */
async function readShopStock(tx: PluginTx, playerId: string): Promise<{ locationId: string; rows: StockRow[] }> {
  const [stats] = await tx.db
    .select({ locationId: playerStats.locationId })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  const locationId = stats?.locationId ?? null;
  // Same answer POST /api/bullets/buy gives a player who is nowhere.
  if (locationId === null) throw new PluginError("no_location", 409);

  // INNER join to `items`: the stock table has no FKs (see shop-schema.ts),
  // so a deleted item leaves an orphan row. The join is what keeps it
  // invisible to players.
  const rows = await tx.db
    .select({
      itemId: items.id, name: items.name, itemType: items.itemType, effects: items.effects,
      price: shopStock.price, stock: shopStock.stock,
    })
    .from(shopStock)
    .innerJoin(items, eq(items.id, shopStock.itemId))
    .where(and(eq(shopStock.locationId, locationId), gt(shopStock.stock, 0)));
  return { locationId, rows };
}

/** One line per numeric effect, `key: value`, in declaration order — a table cell, never an object. */
function effectsCell(effects: unknown): string {
  if (effects === null || typeof effects !== "object") return "";
  return Object.entries(effects as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");
}

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
      const { locationId, rows } = await readShopStock(tx, player.id);

      // Cross-scope read: `items` is a CORE table, so the art lives under the
      // `core` scope even though this plugin is the one rendering it. Reading
      // another scope's art is allowed; binding it is not, and needs the `core`
      // grant through the admin route.
      const art = await ctx.assets.resolve("core", rows.map((row) => row.itemId), "item");

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
            // Omitted rather than null when unbound: the DTO field is optional,
            // and `exactOptionalPropertyTypes` makes the spread the honest way
            // to say "this key may not be here".
            ...(art.has(row.itemId) ? { imageUrl: art.get(row.itemId) as string } : {}),
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
 * A plugin event, not `publishCore`: none of the 21 core `GameEvent` variants
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

/**
 * The purchase, in the caller's transaction. LOCATION FIRST, and that line
 * must stay first: `applyBalanceChange` acquires `player_stats` internally,
 * so no explicit player lock appears here to hint at the ordering (rule 6).
 * Shared by `POST /api/shop/buy` (body) and `POST /api/shop/buy/:id`
 * (one unit) so the two cannot drift.
 */
async function buyFromShop(
  tx: PluginTx, player: { id: string; username: string }, itemId: string, quantity: number,
): Promise<{ cash: string; itemId: string; qty: number; stock: number }> {
  // Step 1, unlocked, and that is safe: a `travel` off this location must
  // hold the row step 2 takes in order to commit, so it cannot slip in
  // between. Reading it under the player lock instead would invert the
  // location -> player order (NOTES.md rule 6).
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
    .where(and(eq(shopStock.locationId, locationId), eq(shopStock.itemId, itemId)));
  if (!row) throw new PluginError("not_sold_here", 409);
  if (row.stock < quantity) {
    throw new PluginError("insufficient_stock", 409, { available: row.stock });
  }

  const cost = row.price * BigInt(quantity);

  let cash: bigint;
  try {
    cash = await tx.economy.applyBalanceChange({
      playerId: player.id,
      amount: -cost,
      kind: "cash",
      reason: "shop.purchase",
      refId: itemId,
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
    .set({ stock: sql`${shopStock.stock} - ${quantity}` })
    .where(and(
      eq(shopStock.locationId, locationId),
      eq(shopStock.itemId, itemId),
      gte(shopStock.stock, quantity),
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
    .values({ playerId: player.id, itemId, qty: quantity })
    .onConflictDoUpdate({
      target: [playerItems.playerId, playerItems.itemId],
      set: { qty: sql`${playerItems.qty} + ${quantity}` },
    })
    .returning({ qty: playerItems.qty });

  await tx.events.publish({
    name: "purchased",
    actorId: player.id,
    actorName: player.username,
    audience: { kind: "player", playerId: player.id },
    payload: {
      itemId,
      name: row.name,
      qty: quantity,
      cost: cost.toString(),
    },
  });

  return {
    cash: cash.toString(),
    itemId,
    qty: owned?.qty ?? quantity,
    stock: remainingStock,
  };
}

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
    return ctx.transaction(async (tx) => ({ status: 200, body: await buyFromShop(tx, player, body.itemId, body.quantity) }));
  },
});

/**
 * The shop as a view-node table (spec 2026-09-18-core-view-pages §1): one
 * string per cell, the row's `id` feeding `POST /api/shop/buy/:id`, and
 * `cannotBuy` riding `disabledKey`. The same read as `GET /api/shop`, through
 * `readShopStock`, so the two listings cannot disagree.
 */
export const shopRowsRoute = route({
  method: "GET",
  path: "/api/shop/rows",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    return ctx.transaction(async (tx) => {
      const { rows } = await readShopStock(tx, player.id);
      const art = await ctx.assets.resolve("core", rows.map((row) => row.itemId), "item");
      return {
        status: 200,
        body: {
          rows: rows.map((row) => ({
            id: row.itemId,
            name: row.name,
            itemType: row.itemType,
            effects: effectsCell(readEffects(row.itemType, row.effects)),
            price: row.price.toString(),
            stock: String(row.stock),
            image: art.get(row.itemId) ?? "",
            cannotBuy: row.price > player.cash ? "true" : "false",
          })),
        },
      };
    });
  },
});

/** One unit, by path token — a table row action carries no body. Same gates and refusals as `buy`. */
export const shopBuyOneRoute = route({
  method: "POST",
  path: "/api/shop/buy/:id",
  accessInJail: false,
  accessInHospital: false,
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    return ctx.transaction(async (tx) => ({ status: 200, body: await buyFromShop(tx, player, params.id, 1) }));
  },
});
