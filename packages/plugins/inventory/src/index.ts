import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt } from "drizzle-orm";
import { items, playerItems, playerStats } from "./schema.js";

const listRoute = route({
  method: "GET",
  path: "/api/inventory",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const owned = await tx.db
        .select({
          itemId: items.id,
          name: items.name,
          itemType: items.itemType,
          effects: items.effects,
          qty: playerItems.qty,
        })
        .from(playerItems)
        .innerJoin(items, eq(items.id, playerItems.itemId))
        .where(and(eq(playerItems.playerId, player.id), gt(playerItems.qty, 0)));

      const [stats] = await tx.db
        .select({
          weaponItemId: playerStats.weaponItemId,
          armorItemId: playerStats.armorItemId,
        })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));

      return {
        status: 200,
        body: {
          items: owned,
          equipped: {
            weaponItemId: stats?.weaponItemId ?? null,
            armorItemId: stats?.armorItemId ?? null,
          },
        },
      };
    });
  },
});

export default definePlugin({
  id: "inventory",
  version: "1.0.0",
  basePaths: ["/api/inventory"],
  routes: [listRoute],
  // No `menu`, `pages`, `events` or `jobs`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }, and buildApp throws at boot if a core
  // plugin declares jobs.
});
