import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt } from "drizzle-orm";
import {
  ArmorEffectsSchema,
  ConsumableEffectsSchema,
  ITEM_TYPE_ARMOR,
  ITEM_TYPE_CONSUMABLE,
  ITEM_TYPE_WEAPON,
  WeaponEffectsSchema,
} from "./effects.js";
import { items, playerItems, playerStats } from "./schema.js";

/**
 * `items.effects` is jsonb an admin can put anything in, so it is parsed
 * rather than forwarded raw. Parsing also fills the weapon defaults
 * (`bulletsPerShot`, `critChance`, `critMultiplier`, `armorPierce`,
 * `minRankExp`), so a client rendering weapon stats sees the same numbers
 * combat will use instead of having to know the defaults itself — a migrated
 * V2 item carries none of them.
 *
 * `item_type` is unconstrained text (`content.ts:64`) and V2 shipped types
 * beyond these three, so an unrecognised type is passed through untouched:
 * this plugin has no schema for it and nothing here interprets it. A KNOWN
 * type that fails to parse yields `null`, which is the same "unusable rather
 * than a 500" answer the equip route gives.
 */
function readEffects(itemType: string, effects: unknown): unknown {
  switch (itemType) {
    case ITEM_TYPE_WEAPON: {
      const parsed = WeaponEffectsSchema.safeParse(effects);
      return parsed.success ? parsed.data : null;
    }
    case ITEM_TYPE_ARMOR: {
      const parsed = ArmorEffectsSchema.safeParse(effects);
      return parsed.success ? parsed.data : null;
    }
    case ITEM_TYPE_CONSUMABLE: {
      const parsed = ConsumableEffectsSchema.safeParse(effects);
      return parsed.success ? parsed.data : null;
    }
    default:
      return effects;
  }
}

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
          items: owned.map((row) => ({ ...row, effects: readEffects(row.itemType, row.effects) })),
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
