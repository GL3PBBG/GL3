import {
  definePlugin, newId, PluginError, route,
  type PageSchema,
} from "@gl3/plugin-sdk";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ArmorEffectsSchema,
  ConsumableEffectsSchema,
  ITEM_TYPE_ARMOR,
  ITEM_TYPE_CONSUMABLE,
  ITEM_TYPE_WEAPON,
  readEffects,
  WeaponEffectsSchema,
} from "./effects.js";
import { SHOP_MIGRATIONS } from "./migrations.js";
import { items, locations, playerItems, playerStats, ranks } from "./schema.js";
import { purchasedEvent, shopBuyRoute, shopListRoute } from "./shop.js";
import { shopStock } from "./shop-schema.js";

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

/**
 * `.optional().nullable()` on both, because `undefined` and `null` mean
 * different things here and must not collapse: an absent key leaves the slot
 * alone, an explicit `null` unequips it. The handler distinguishes them with
 * an `in` check, not a truthiness test.
 */
const EquipSchema = z.object({
  weaponItemId: z.string().uuid().nullable().optional(),
  armorItemId: z.string().uuid().nullable().optional(),
});

const equipRoute = route({
  method: "PUT",
  path: "/api/inventory/equip",
  accessInJail: false,
  accessInHospital: false,
  body: EquipSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const wantsWeapon = "weaponItemId" in body;
    const wantsArmor = "armorItemId" in body;

    return ctx.transaction(async (tx) => {
      // The player's own row only — no second participant, so the single-id
      // form of the standard ascending-order lock. The UPDATE below also
      // takes FOR KEY SHARE on the referenced items row through
      // player_stats' weapon_item_id/armor_item_id FKs (NOTES.md rule 6);
      // nothing in the codebase locks an items row, so there is no path to
      // invert against.
      await tx.locks.player([player.id]);

      const [stats] = await tx.db
        .select({
          exp: playerStats.exp,
          weaponItemId: playerStats.weaponItemId,
          armorItemId: playerStats.armorItemId,
        })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (!stats) throw new PluginError("unauthorized", 401);

      /** Verifies ownership, slot, and (for weapons) the rank gate. */
      const validate = async (itemId: string, slot: "weapon" | "armor"): Promise<void> => {
        const [owned] = await tx.db
          .select({ itemType: items.itemType, effects: items.effects, qty: playerItems.qty })
          .from(playerItems)
          .innerJoin(items, eq(items.id, playerItems.itemId))
          .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, itemId)));

        if (!owned || owned.qty <= 0) throw new PluginError("not_owned", 409);

        const expectedType = slot === "weapon" ? ITEM_TYPE_WEAPON : ITEM_TYPE_ARMOR;
        if (owned.itemType !== expectedType) throw new PluginError("wrong_slot", 400);

        if (slot === "weapon") {
          const parsed = WeaponEffectsSchema.safeParse(owned.effects);
          // A malformed weapon is unusable rather than a 500: the jsonb is an
          // external boundary and an admin can put anything in it.
          if (!parsed.success) throw new PluginError("wrong_slot", 400);
          if (BigInt(parsed.data.minRankExp) > stats.exp) {
            throw new PluginError("rank_too_low", 409);
          }
        } else {
          const parsed = ArmorEffectsSchema.safeParse(owned.effects);
          if (!parsed.success) throw new PluginError("wrong_slot", 400);
        }
      };

      const nextWeapon = wantsWeapon ? (body.weaponItemId ?? null) : stats.weaponItemId;
      const nextArmor = wantsArmor ? (body.armorItemId ?? null) : stats.armorItemId;

      if (wantsWeapon && body.weaponItemId != null) await validate(body.weaponItemId, "weapon");
      if (wantsArmor && body.armorItemId != null) await validate(body.armorItemId, "armor");

      await tx.db
        .update(playerStats)
        .set({ weaponItemId: nextWeapon, armorItemId: nextArmor })
        .where(eq(playerStats.playerId, player.id));

      return { status: 200, body: { weaponItemId: nextWeapon, armorItemId: nextArmor } };
    });
  },
});

const useRoute = route({
  method: "POST",
  path: "/api/inventory/use/:itemId",
  accessInJail: false,
  // What structurally enforces "a heal item does not get you out of hospital":
  // the loader answers 423 before this handler runs.
  accessInHospital: false,
  params: z.object({ itemId: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [owned] = await tx.db
        .select({ itemType: items.itemType, effects: items.effects, qty: playerItems.qty })
        .from(playerItems)
        .innerJoin(items, eq(items.id, playerItems.itemId))
        .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, params.itemId)));
      if (!owned || owned.qty <= 0) throw new PluginError("not_owned", 409);
      if (owned.itemType !== ITEM_TYPE_CONSUMABLE) throw new PluginError("wrong_slot", 400);

      const parsed = ConsumableEffectsSchema.safeParse(owned.effects);
      if (!parsed.success) throw new PluginError("wrong_slot", 400);

      const [stats] = await tx.db
        .select({ health: playerStats.health, maxHealth: ranks.maxHealth })
        .from(playerStats)
        .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
        .where(eq(playerStats.playerId, player.id));
      if (!stats) throw new PluginError("unauthorized", 401);

      // 100 matches core's `ranks.max_health` column default and
      // hospital/status.ts's DEFAULT_MAX_HEALTH, used when the player has no
      // rank row yet. A plugin cannot import that constant from apps/server,
      // so the two must be kept in step by hand.
      const maxHealth = stats.maxHealth ?? 100;
      if (stats.health >= maxHealth) throw new PluginError("already_full", 409);

      // The decrement is the guard, not a preceding read: `qty > 0` in the
      // WHERE makes a concurrent second use match zero rows instead of driving
      // the count negative. Same reasoning as NOTES.md rule 2's ban on
      // check-then-act, applied to Postgres.
      const decremented = await tx.db
        .update(playerItems)
        .set({ qty: sql`${playerItems.qty} - 1` })
        .where(and(
          eq(playerItems.playerId, player.id),
          eq(playerItems.itemId, params.itemId),
          gt(playerItems.qty, 0),
        ))
        .returning({ qty: playerItems.qty });
      const remaining = decremented[0]?.qty;
      if (remaining === undefined) throw new PluginError("not_owned", 409);

      const health = Math.min(maxHealth, stats.health + parsed.data.heal);
      await tx.db.update(playerStats).set({ health }).where(eq(playerStats.playerId, player.id));

      return {
        status: 200,
        body: { health, healed: health - stats.health, qty: remaining },
      };
    });
  },
});

// --- Admin schemas ---

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");

const ItemBodySchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal("weapon"),
    name: z.string().min(1).max(80),
    damageMin: z.coerce.number().int().nonnegative(),
    damageMax: z.coerce.number().int().nonnegative(),
    accuracy: z.coerce.number().int().min(0).max(100).optional(),
  }).strict(),
  z.object({
    itemType: z.literal("armor"),
    name: z.string().min(1).max(80),
    armor: z.coerce.number().int().nonnegative(),
  }).strict(),
  z.object({
    itemType: z.literal("consumable"),
    name: z.string().min(1).max(80),
    heal: z.coerce.number().int().positive(),
  }).strict(),
]);

const ShopStockBodySchema = z.object({
  locationId: z.string().uuid(),
  itemId: z.string().uuid(),
  price: AdminMoney,
  stock: z.coerce.number().int().nonnegative(),
}).strict();

// --- Admin routes ---

const adminItemListRoute = route({
  method: "GET", path: "/api/admin/inventory/items", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(items));
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          itemType: r.itemType,
          effects: JSON.stringify(r.effects),
        })),
      },
    };
  },
});

const adminItemCreateRoute = route({
  method: "POST", path: "/api/admin/inventory/items", auth: "admin",
  body: ItemBodySchema,
  handler: async (ctx, { body }) => {
    let effects: unknown;
    try {
      switch (body.itemType) {
        case "weapon":
          effects = WeaponEffectsSchema.parse({
            damageMin: body.damageMin,
            damageMax: body.damageMax,
            ...(body.accuracy !== undefined && { accuracy: body.accuracy }),
          });
          break;
        case "armor":
          effects = ArmorEffectsSchema.parse({ armor: body.armor });
          break;
        case "consumable":
          effects = ConsumableEffectsSchema.parse({ heal: body.heal });
          break;
      }
    } catch {
      throw new PluginError("invalid_effects", 400);
    }

    const id = newId();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(items).values({
        id,
        name: body.name,
        itemType: body.itemType,
        effects,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminShopListRoute = route({
  method: "GET", path: "/api/admin/inventory/shop", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db
        .select({
          locationId: shopStock.locationId,
          locationName: locations.name,
          itemId: shopStock.itemId,
          itemName: items.name,
          price: shopStock.price,
          stock: shopStock.stock,
        })
        .from(shopStock)
        .innerJoin(locations, eq(locations.id, shopStock.locationId))
        .innerJoin(items, eq(items.id, shopStock.itemId)),
    );
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          locationId: r.locationId,
          locationName: r.locationName,
          itemId: r.itemId,
          itemName: r.itemName,
          price: r.price.toString(),
          stock: String(r.stock),
        })),
      },
    };
  },
});

const adminShopUpsertRoute = route({
  method: "POST", path: "/api/admin/inventory/shop", auth: "admin",
  body: ShopStockBodySchema,
  handler: async (ctx, { body }) => {
    // Plain SELECT checks — accepted race per shop-schema.ts docs.
    const [loc] = await ctx.transaction(async (tx) =>
      tx.db.select({ id: locations.id }).from(locations).where(eq(locations.id, body.locationId)),
    );
    if (!loc) throw new PluginError("location_not_found", 404);

    const [item] = await ctx.transaction(async (tx) =>
      tx.db.select({ id: items.id }).from(items).where(eq(items.id, body.itemId)),
    );
    if (!item) throw new PluginError("item_not_found", 404);

    await ctx.transaction(async (tx) =>
      tx.db.insert(shopStock).values({
        locationId: body.locationId,
        itemId: body.itemId,
        price: BigInt(body.price),
        stock: body.stock,
      }).onConflictDoUpdate({
        target: [shopStock.locationId, shopStock.itemId],
        set: { price: BigInt(body.price), stock: body.stock },
      }),
    );
    return { status: 204 };
  },
});

const adminPage: PageSchema = {
  id: "inventory-admin",
  path: "/admin/inventory",
  view: {
    kind: "panel", title: "Inventory",
    children: [
      {
        kind: "panel", title: "Items",
        children: [
          { kind: "table", source: "GET /api/admin/inventory/items", columns: [
            { key: "id", label: "Id" },
            { key: "name", label: "Name" },
            { key: "itemType", label: "Type" },
            { key: "effects", label: "Effects" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add weapon", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", label: "Type (weapon)", type: "text" },
            { name: "damageMin", label: "Damage min", type: "number" },
            { name: "damageMax", label: "Damage max", type: "number" },
            { name: "accuracy", label: "Accuracy (0-100)", type: "number" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add armor", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", label: "Type (armor)", type: "text" },
            { name: "armor", label: "Armor", type: "number" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add consumable", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", label: "Type (consumable)", type: "text" },
            { name: "heal", label: "Heal", type: "number" },
          ] },
        ],
      },
      {
        kind: "panel", title: "Shop stock",
        children: [
          { kind: "table", source: "GET /api/admin/inventory/shop", columns: [
            { key: "locationId", label: "Location id" },
            { key: "locationName", label: "Location" },
            { key: "itemId", label: "Item id" },
            { key: "itemName", label: "Item" },
            { key: "price", label: "Price" },
            { key: "stock", label: "Stock" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/shop", submitLabel: "Set stock", fields: [
            { name: "locationId", label: "Location id (paste from table)", type: "text" },
            { name: "itemId", label: "Item id (paste from table)", type: "text" },
            { name: "price", label: "Price", type: "money" },
            { name: "stock", label: "Stock", type: "number" },
          ] },
        ],
      },
    ],
  },
};

export default definePlugin({
  id: "inventory",
  version: "1.0.0",
  basePaths: ["/api/inventory", "/api/shop", "/api/admin/inventory"],
  tables: { shopStock: "p_inventory_shop_stock" },
  migrations: SHOP_MIGRATIONS,
  routes: [
    listRoute, equipRoute, useRoute, shopListRoute, shopBuyRoute,
    adminItemListRoute, adminItemCreateRoute, adminShopListRoute, adminShopUpsertRoute,
  ],
  events: [purchasedEvent],
  // No `menu`, `pages` or `jobs`: plugin-manifest-endpoint.test.ts:87 asserts
  // a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }, and buildApp throws at boot if a
  // core plugin declares jobs. `adminPages` is not `pages` — it is served
  // separately by GET /api/admin/plugins and never reaches that payload.
  adminPages: [adminPage],
});
