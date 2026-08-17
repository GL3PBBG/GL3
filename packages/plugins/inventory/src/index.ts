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
      // player_stats' weapon_item_id/armor_item_id FKs (CLAUDE.md rule 6);
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
      // the count negative. Same reasoning as CLAUDE.md rule 2's ban on
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

/**
 * The page renderer posts *every* field in a form, sending "" for the ones the
 * admin left blank (`PageRenderer.tsx`, the form's onSubmit). `z.coerce.number()`
 * reads "" as 0, so an optional numeric field without this would arrive as a
 * stated zero rather than absent — and for a weapon's accuracy those are
 * different weapons: absent means "combat fills it from its own setting",
 * 0 means "never hits". Blank is normalised to `undefined` here so
 * `WeaponEffectsSchema`'s defaults apply instead.
 */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

/**
 * Every field of `WeaponEffectsSchema` except the two required damage bounds,
 * which have no default and must be stated. The admin UI sets all of them: the
 * five below used to be absent from both this schema and the form, so an
 * admin-created weapon was frozen at the schema defaults forever.
 */
const WeaponStatFields = {
  accuracy: blankable(z.coerce.number().int().min(0).max(100)),
  bulletsPerShot: blankable(z.coerce.number().int().positive()),
  critChance: blankable(z.coerce.number().int().min(0).max(100)),
  /** One of two floats in the vocabulary — hence the `decimal` form field type. */
  critMultiplier: blankable(z.coerce.number().min(1)),
  armorPierce: blankable(z.coerce.number().int().nonnegative()),
  minRankExp: blankable(z.coerce.number().int().nonnegative()),
  /**
   * The other float, and the one that paces the attack cooldown: combat waits
   * the weapon's average damage divided by this. Positive, so a 400 here is
   * where `dps: 0` dies rather than as a division by zero downstream. Blank
   * leaves it absent, which keeps the flat `combat.cooldown_seconds`.
   */
  dps: blankable(z.coerce.number().positive()),
} as const;

const WeaponStatsShape = {
  damageMin: z.coerce.number().int().nonnegative(),
  damageMax: z.coerce.number().int().nonnegative(),
  ...WeaponStatFields,
} as const;

const ArmorStatsShape = { armor: z.coerce.number().int().nonnegative() } as const;
const ConsumableStatsShape = { heal: z.coerce.number().int().positive() } as const;

const ItemBodySchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal(ITEM_TYPE_WEAPON),
    name: z.string().min(1).max(80),
    ...WeaponStatsShape,
  }).strict(),
  z.object({
    itemType: z.literal(ITEM_TYPE_ARMOR),
    name: z.string().min(1).max(80),
    ...ArmorStatsShape,
  }).strict(),
  z.object({
    itemType: z.literal(ITEM_TYPE_CONSUMABLE),
    name: z.string().min(1).max(80),
    ...ConsumableStatsShape,
  }).strict(),
]);

/**
 * Update carries the same stats as create plus the row id, and makes `name`
 * optional so an admin rebalancing a weapon does not have to retype its name.
 * Blank is "leave it" for the same reason it is "absent" above.
 */
const ItemUpdateSchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal(ITEM_TYPE_WEAPON),
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    ...WeaponStatsShape,
  }).strict(),
  z.object({
    itemType: z.literal(ITEM_TYPE_ARMOR),
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    ...ArmorStatsShape,
  }).strict(),
  z.object({
    itemType: z.literal(ITEM_TYPE_CONSUMABLE),
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    ...ConsumableStatsShape,
  }).strict(),
]);

type ItemStatsBody =
  | ({ itemType: typeof ITEM_TYPE_WEAPON } & z.infer<z.ZodObject<typeof WeaponStatsShape>>)
  | ({ itemType: typeof ITEM_TYPE_ARMOR } & z.infer<z.ZodObject<typeof ArmorStatsShape>>)
  | ({ itemType: typeof ITEM_TYPE_CONSUMABLE } & z.infer<z.ZodObject<typeof ConsumableStatsShape>>);

/**
 * Turn a validated body into the `effects` jsonb. The per-type effects schema
 * runs a second time here on purpose: it is what applies the weapon defaults
 * and enforces `damageMax >= damageMin`, neither of which the body schema
 * expresses. `...(x !== undefined && { x })` rather than passing the key
 * through — an explicit `undefined` would defeat `.default()`.
 */
function effectsFor(body: ItemStatsBody): unknown {
  try {
    switch (body.itemType) {
      case ITEM_TYPE_WEAPON:
        return WeaponEffectsSchema.parse({
          damageMin: body.damageMin,
          damageMax: body.damageMax,
          ...(body.accuracy !== undefined && { accuracy: body.accuracy }),
          ...(body.bulletsPerShot !== undefined && { bulletsPerShot: body.bulletsPerShot }),
          ...(body.critChance !== undefined && { critChance: body.critChance }),
          ...(body.critMultiplier !== undefined && { critMultiplier: body.critMultiplier }),
          ...(body.armorPierce !== undefined && { armorPierce: body.armorPierce }),
          ...(body.minRankExp !== undefined && { minRankExp: body.minRankExp }),
          ...(body.dps !== undefined && { dps: body.dps }),
        });
      case ITEM_TYPE_ARMOR:
        return ArmorEffectsSchema.parse({ armor: body.armor });
      case ITEM_TYPE_CONSUMABLE:
        return ConsumableEffectsSchema.parse({ heal: body.heal });
    }
  } catch {
    throw new PluginError("invalid_effects", 400);
  }
}

const ShopStockBodySchema = z.object({
  locationId: z.string().uuid(),
  itemId: z.string().uuid(),
  price: AdminMoney,
  stock: z.coerce.number().int().nonnegative(),
}).strict();

// --- Admin routes ---

/**
 * One flat string per stat, because a `table` node renders exactly that. The
 * listing used to carry `JSON.stringify(effects)` in a single column, which
 * rendered as a wall of braces the admin could read but not act on — the stat
 * names in it did not even line up with any form field, because five of them
 * had no form field at all.
 *
 * Three conventions, and the difference between them matters:
 *   ""        the stat does not exist for this item's type
 *   "—"       the stat exists, is optional, and this item does not state it
 *             (a V2-migrated weapon has no accuracy)
 *   "invalid" the type is one this plugin knows but the jsonb does not parse
 *
 * An unrecognised `item_type` — `items.item_type` is unconstrained text and V2
 * shipped types beyond these three — gets blanks everywhere: this plugin has
 * no schema for it and inventing one would be a lie.
 */
function statCells(itemType: string, effects: unknown): Record<string, string> {
  const blank = {
    damage: "", accuracy: "", bulletsPerShot: "", critChance: "",
    critMultiplier: "", armorPierce: "", minRankExp: "", dps: "", armor: "", heal: "",
  };
  const parsed = readEffects(itemType, effects);
  const known = itemType === ITEM_TYPE_WEAPON
    || itemType === ITEM_TYPE_ARMOR
    || itemType === ITEM_TYPE_CONSUMABLE;
  if (!known) return blank;
  // `readEffects` answers null for a known type it cannot parse.
  if (parsed === null) {
    switch (itemType) {
      case ITEM_TYPE_WEAPON: return { ...blank, damage: "invalid" };
      case ITEM_TYPE_ARMOR: return { ...blank, armor: "invalid" };
      default: return { ...blank, heal: "invalid" };
    }
  }
  switch (itemType) {
    case ITEM_TYPE_WEAPON: {
      const w = WeaponEffectsSchema.parse(parsed);
      return {
        ...blank,
        damage: `${w.damageMin}–${w.damageMax}`,
        accuracy: w.accuracy === undefined ? "—" : String(w.accuracy),
        bulletsPerShot: String(w.bulletsPerShot),
        critChance: String(w.critChance),
        critMultiplier: String(w.critMultiplier),
        armorPierce: String(w.armorPierce),
        minRankExp: String(w.minRankExp),
        // Em dash, like `accuracy`: absent is not zero. An unpaced weapon
        // keeps the flat cooldown, and showing "0" would read as instant.
        dps: w.dps === undefined ? "—" : String(w.dps),
      };
    }
    case ITEM_TYPE_ARMOR:
      return { ...blank, armor: String(ArmorEffectsSchema.parse(parsed).armor) };
    default:
      return { ...blank, heal: String(ConsumableEffectsSchema.parse(parsed).heal) };
  }
}

const adminItemListRoute = route({
  method: "GET", path: "/api/admin/inventory/items", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(items));
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          // `id` is never a table column — it is every select's valueKey, which
          // `test/admin-ids-hidden.test.ts` enforces across every admin page.
          id: r.id,
          name: r.name,
          itemType: r.itemType,
          ...statCells(r.itemType, r.effects),
        })),
      },
    };
  },
});

const adminItemCreateRoute = route({
  method: "POST", path: "/api/admin/inventory/items", auth: "admin",
  body: ItemBodySchema,
  handler: async (ctx, { body }) => {
    const effects = effectsFor(body);
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

const adminItemUpdateRoute = route({
  method: "POST", path: "/api/admin/inventory/items/update", auth: "admin",
  body: ItemUpdateSchema,
  handler: async (ctx, { body }) => {
    const effects = effectsFor(body);
    const outcome = await ctx.transaction(async (tx) => {
      // Read the type before writing: the form's item select lists every item
      // regardless of type, so the armor form can be pointed at a weapon.
      // Writing `{ armor: n }` onto an item_type of `weapon` would leave a row
      // whose type and effects disagree, which readEffects then reports as
      // null and equipping refuses — a bricked item, from a valid-looking
      // submit. Refuse it instead.
      const [existing] = await tx.db
        .select({ itemType: items.itemType })
        .from(items)
        .where(eq(items.id, body.id));
      if (!existing) return "not_found" as const;
      if (existing.itemType !== body.itemType) return "mismatch" as const;
      await tx.db
        .update(items)
        .set({ effects, ...(body.name !== undefined && { name: body.name }) })
        .where(eq(items.id, body.id));
      return "ok" as const;
    });
    if (outcome === "not_found") throw new PluginError("item_not_found", 404);
    if (outcome === "mismatch") throw new PluginError("item_type_mismatch", 400);
    return { status: 204 };
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

// Feeds the shop form's location select. The shop listing cannot serve that
// role: it lists existing stock rows, which is empty exactly when the admin
// stocks a location for the first time.
const adminLocationListRoute = route({
  method: "GET", path: "/api/admin/inventory/locations", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select({ id: locations.id, name: locations.name }).from(locations),
    );
    return { status: 200, body: { rows } };
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

/**
 * Declared once and spread into both the add-weapon and update-weapon forms:
 * they must offer the same stats, and the reason this page needed fixing in
 * the first place is that a stat existed in `WeaponEffectsSchema` with no form
 * field anywhere to set it.
 *
 * `critMultiplier` is the one `decimal`. As a `number` the browser applies the
 * default `step="1"` and refuses to submit 1.5.
 */
const WEAPON_STAT_FORM_FIELDS = [
  { name: "damageMin", label: "Damage min", type: "number" },
  { name: "damageMax", label: "Damage max", type: "number" },
  { name: "accuracy", label: "Accuracy % (blank = combat default)", type: "number" },
  { name: "bulletsPerShot", label: "Bullets per shot (blank = 1)", type: "number" },
  { name: "critChance", label: "Crit chance % (blank = 0)", type: "number" },
  { name: "critMultiplier", label: "Crit multiplier (blank = 1)", type: "decimal" },
  { name: "armorPierce", label: "Armor pierce (blank = 0)", type: "number" },
  { name: "minRankExp", label: "Min rank exp (blank = 0)", type: "number" },
  // `decimal` for the same reason `critMultiplier` is: a `number` input takes
  // the default step="1" and refuses to submit 0.5 — the exact value a
  // half-rate weapon needs.
  { name: "dps", label: "Damage/sec (blank = flat cooldown)", type: "decimal" },
] as const satisfies readonly { name: string; label: string; type: "number" | "decimal" }[];

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
            { key: "name", label: "Name" },
            { key: "itemType", label: "Type" },
            { key: "damage", label: "Damage" },
            { key: "accuracy", label: "Accuracy" },
            { key: "bulletsPerShot", label: "Bullets/shot" },
            { key: "critChance", label: "Crit %" },
            { key: "critMultiplier", label: "Crit ×" },
            { key: "armorPierce", label: "Pierce" },
            { key: "minRankExp", label: "Min rank exp" },
            { key: "dps", label: "DPS" },
            { key: "armor", label: "Armor" },
            { key: "heal", label: "Heal" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add weapon", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_WEAPON },
            ...WEAPON_STAT_FORM_FIELDS,
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add armor", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_ARMOR },
            { name: "armor", label: "Armor", type: "number" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add consumable", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_CONSUMABLE },
            { name: "heal", label: "Heal", type: "number" },
          ] },
        ],
      },
      {
        kind: "panel", title: "Edit an item",
        children: [
          { kind: "text", value: "Pick an item in the form matching its type. Leave a stat blank to take its default; leave the name blank to keep the current one." },
          { kind: "form", action: "POST /api/admin/inventory/items/update", submitLabel: "Update weapon", fields: [
            { name: "id", label: "Item", type: "select", optionsSource: "GET /api/admin/inventory/items", valueKey: "id", labelKey: "name" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_WEAPON },
            { name: "name", label: "Rename to (optional)", type: "text" },
            ...WEAPON_STAT_FORM_FIELDS,
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items/update", submitLabel: "Update armor", fields: [
            { name: "id", label: "Item", type: "select", optionsSource: "GET /api/admin/inventory/items", valueKey: "id", labelKey: "name" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_ARMOR },
            { name: "name", label: "Rename to (optional)", type: "text" },
            { name: "armor", label: "Armor", type: "number" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items/update", submitLabel: "Update consumable", fields: [
            { name: "id", label: "Item", type: "select", optionsSource: "GET /api/admin/inventory/items", valueKey: "id", labelKey: "name" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_CONSUMABLE },
            { name: "name", label: "Rename to (optional)", type: "text" },
            { name: "heal", label: "Heal", type: "number" },
          ] },
        ],
      },
      {
        kind: "panel", title: "Shop stock",
        children: [
          { kind: "table", source: "GET /api/admin/inventory/shop", columns: [
            { key: "locationName", label: "Location" },
            { key: "itemName", label: "Item" },
            { key: "price", label: "Price" },
            { key: "stock", label: "Stock" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/shop", submitLabel: "Set stock", fields: [
            { name: "locationId", label: "Location", type: "select", optionsSource: "GET /api/admin/inventory/locations", valueKey: "id", labelKey: "name" },
            { name: "itemId", label: "Item", type: "select", optionsSource: "GET /api/admin/inventory/items", valueKey: "id", labelKey: "name" },
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
    adminItemListRoute, adminItemCreateRoute, adminItemUpdateRoute,
    adminShopListRoute, adminShopUpsertRoute,
    adminLocationListRoute,
  ],
  events: [purchasedEvent],
  // No `menu`, `pages` or `jobs`: plugin-manifest-endpoint.test.ts:87 asserts
  // a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }, and buildApp throws at boot if a
  // core plugin declares jobs. `adminPages` is not `pages` — it is served
  // separately by GET /api/admin/plugins and never reaches that payload.
  adminPages: [adminPage],
});
