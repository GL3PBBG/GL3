import {
  definePlugin, filterPoint, newId, PluginError, route,
  type PageSchema,
} from "@gl3/plugin-sdk";
import { ItemActionSchema } from "@gl3/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ArmorEffectsSchema,
  ConsumableEffectsSchema,
  ITEM_TYPE_ARMOR,
  ITEM_TYPE_CONSUMABLE,
  ITEM_TYPE_WEAPON,
  MeleeEffectsSchema,
  readEffects,
  WeaponEffectsSchema,
} from "./effects.js";
import {
  boundOutcome,
  buildEffectRegistry,
  consumableKind,
  guardEffect,
  HEAL_EFFECT_KIND,
  itemEffects,
  POOL_ORDER,
  readConsumableUse,
} from "./effect-registry.js";
import { SHOP_MIGRATIONS } from "./migrations.js";
import { items, locations, playerItems, playerStats, ranks } from "./schema.js";
import { purchasedEvent, shopBuyRoute, shopListRoute } from "./shop.js";
import { shopStock } from "./shop-schema.js";

/**
 * Lets another plugin attach a link to an inventory row (combat's gunsmith
 * repair on a weapon, the first subscriber). `"collect"`: a throwing
 * subscriber loses only its own contribution, never the listing itself —
 * this point mirrors `core.dashboard`'s shape, not `combat.killResolved`'s.
 */
export interface ItemActionsValue {
  items: { itemId: string; itemType: string }[];
  actions: { itemId: string; pluginId: string; label: string; to: string }[];
}
export const itemActions = filterPoint<ItemActionsValue>("inventory.itemActions", "collect");

const listRoute = route({
  method: "GET",
  path: "/api/inventory",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const { owned, stats } = await ctx.transaction(async (tx) => {
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
          weaponMeleeItemId: playerStats.weaponMeleeItemId,
          armorItemId: playerStats.armorItemId,
        })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));

      return { owned, stats };
    });

    // One lookup for the whole inventory, not one per row. `items` is a core
    // table, hence the `core` scope rather than this plugin's own.
    const art = await ctx.assets.resolve("core", owned.map((row) => row.itemId), "item");

    // Filters run outside any transaction (spec: Filters) — this must run
    // after `ctx.transaction` above returns, not inside it.
    const acted = await ctx.filters.apply(itemActions, {
      items: owned.map((row) => ({ itemId: row.itemId, itemType: row.itemType })),
      actions: [],
    });

    // Only when the player actually holds a consumable: the registry costs a
    // second filter chain, and a page listing nothing but weapons has no use
    // for it. `label` is server-side, so a non-heal consumable would otherwise
    // reach the page as a bare kind string.
    const effectLabels = owned.some((row) => row.itemType === ITEM_TYPE_CONSUMABLE)
      ? await buildEffectRegistry(ctx)
      : new Map<string, { label: string }>();

    return {
      status: 200,
      body: {
        items: owned.map((row) => {
          // The shared `ItemActionSchema` is `.strict()` on `{ pluginId, label,
          // to }` — `itemId` is implicit from which item's array it lives in,
          // so it is dropped here rather than carried onto the wire twice.
          // Then re-validated per-action against that same schema: a
          // `"collect"`-policy subscriber's malformed action (a
          // `PLUGIN_PACKAGES`-loaded plugin is never typechecked against it)
          // must lose only its own entry, not the whole inventory row.
          const rowActions = acted.actions
            .filter((a) => a.itemId === row.itemId)
            .map(({ pluginId, label, to }) => ({ pluginId, label, to }))
            .filter((action) => {
              const parsed = ItemActionSchema.safeParse(action);
              if (!parsed.success) {
                ctx.log.warn("dropped a malformed item action", {
                  pointName: itemActions.name, itemId: row.itemId, action, issues: parsed.error.issues,
                });
              }
              return parsed.success;
            });
          // An unregistered kind gets no label: the page falls back to the raw
          // kind, which is more honest than inventing a name for a def this
          // deployment does not have.
          // Omitted for the built-in heal too: the page renders "heals 20" for
          // that from `effects` alone and has no use for a second name.
          const kind = row.itemType === ITEM_TYPE_CONSUMABLE
            ? consumableKind(row.effects)
            : null;
          const label = kind === null || kind === HEAL_EFFECT_KIND
            ? undefined
            : effectLabels.get(kind)?.label;
          return {
            ...row,
            effects: readEffects(row.itemType, row.effects),
            ...(art.has(row.itemId) ? { imageUrl: art.get(row.itemId) as string } : {}),
            ...(rowActions.length > 0 ? { actions: rowActions } : {}),
            ...(label !== undefined ? { effectLabel: label } : {}),
          };
        }),
        equipped: {
          weaponItemId: stats?.weaponItemId ?? null,
          weaponMeleeItemId: stats?.weaponMeleeItemId ?? null,
          armorItemId: stats?.armorItemId ?? null,
        },
      },
    };
  },
});

/**
 * `.optional().nullable()` on all three, because `undefined` and `null` mean
 * different things here and must not collapse: an absent key leaves the slot
 * alone, an explicit `null` unequips it. The handler distinguishes them with
 * an `in` check, not a truthiness test.
 */
const EquipSchema = z.object({
  weaponItemId: z.string().uuid().nullable().optional(),
  weaponMeleeItemId: z.string().uuid().nullable().optional(),
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
    const wantsMelee = "weaponMeleeItemId" in body;
    const wantsArmor = "armorItemId" in body;

    return ctx.transaction(async (tx) => {
      // The player's own row only — no second participant, so the single-id
      // form of the standard ascending-order lock. The UPDATE below also
      // takes FOR KEY SHARE on the referenced items row through
      // player_stats' weapon/armor/melee-slot FKs (NOTES.md rule 6);
      // nothing in the codebase locks an items row, so there is no path to
      // invert against.
      await tx.locks.player([player.id]);

      const [stats] = await tx.db
        .select({
          exp: playerStats.exp,
          weaponItemId: playerStats.weaponItemId,
          weaponMeleeItemId: playerStats.weaponMeleeItemId,
          armorItemId: playerStats.armorItemId,
        })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (!stats) throw new PluginError("unauthorized", 401);

      /**
       * Verifies ownership, slot, and (for firearms) the rank gate. The
       * melee slot is the one place the model is part of the contract
       * (B0 §2.1): only a melee item — `power` effects — may occupy it, so
       * the firearm path can trust slot 1's armed-or-empty dichotomy.
       */
      const validate = async (itemId: string, slot: "weapon" | "weapon-melee" | "armor"): Promise<void> => {
        const [owned] = await tx.db
          .select({ itemType: items.itemType, effects: items.effects, qty: playerItems.qty })
          .from(playerItems)
          .innerJoin(items, eq(items.id, playerItems.itemId))
          .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, itemId)));

        if (!owned || owned.qty <= 0) throw new PluginError("not_owned", 409);

        const expectedType = slot === "armor" ? ITEM_TYPE_ARMOR : ITEM_TYPE_WEAPON;
        if (owned.itemType !== expectedType) throw new PluginError("wrong_slot", 400);

        if (slot === "weapon") {
          // A melee item in slot 1 is legal (C6's arm fires it); anything
          // malformed is unusable rather than a 500: the jsonb is an
          // external boundary.
          const melee = MeleeEffectsSchema.safeParse(owned.effects);
          if (!melee.success) {
            const parsed = WeaponEffectsSchema.safeParse(owned.effects);
            if (!parsed.success) throw new PluginError("wrong_slot", 400);
            if (BigInt(parsed.data.minRankExp) > stats.exp) {
              throw new PluginError("rank_too_low", 409);
            }
          }
        } else if (slot === "weapon-melee") {
          // The gate itself: melee models only. A firearm here is refused —
          // combat would never fire it from this slot anyway (defense in
          // depth both ways).
          const parsed = MeleeEffectsSchema.safeParse(owned.effects);
          if (!parsed.success) throw new PluginError("wrong_slot", 400);
        } else {
          const parsed = ArmorEffectsSchema.safeParse(owned.effects);
          if (!parsed.success) throw new PluginError("wrong_slot", 400);
        }
      };

      const nextWeapon = wantsWeapon ? (body.weaponItemId ?? null) : stats.weaponItemId;
      const nextMelee = wantsMelee ? (body.weaponMeleeItemId ?? null) : stats.weaponMeleeItemId;
      const nextArmor = wantsArmor ? (body.armorItemId ?? null) : stats.armorItemId;

      if (wantsWeapon && body.weaponItemId != null) await validate(body.weaponItemId, "weapon");
      if (wantsMelee && body.weaponMeleeItemId != null) await validate(body.weaponMeleeItemId, "weapon-melee");
      if (wantsArmor && body.armorItemId != null) await validate(body.armorItemId, "armor");

      await tx.db
        .update(playerStats)
        .set({ weaponItemId: nextWeapon, weaponMeleeItemId: nextMelee, armorItemId: nextArmor })
        .where(eq(playerStats.playerId, player.id));

      return {
        status: 200,
        body: { weaponItemId: nextWeapon, weaponMeleeItemId: nextMelee, armorItemId: nextArmor },
      };
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

    // Filters run OUTSIDE any transaction (spec: Filters), so the registry is
    // built before the lock is taken rather than inside the handler below.
    const registry = await buildEffectRegistry(ctx);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [owned] = await tx.db
        .select({
          itemType: items.itemType,
          effects: items.effects,
          meta: items.meta,
          qty: playerItems.qty,
        })
        .from(playerItems)
        .innerJoin(items, eq(items.id, playerItems.itemId))
        .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, params.itemId)));
      if (!owned || owned.qty <= 0) throw new PluginError("not_owned", 409);
      if (owned.itemType !== ITEM_TYPE_CONSUMABLE) throw new PluginError("wrong_slot", 400);

      const use = readConsumableUse(owned.effects, owned.meta);
      if (use === null) throw new PluginError("wrong_slot", 400);

      // Resolved BEFORE the decrement: an item naming a kind nobody registered
      // must not be spent. Same position the `wrong_slot` parse used to hold.
      const def = registry.get(use.kind);
      if (def === undefined) throw new PluginError("unknown_effect", 400, { kind: use.kind });

      const [stats] = await tx.db
        .select({
          health: playerStats.health,
          healthMaxOverride: playerStats.healthMax,
          exp: playerStats.exp,
          cash: playerStats.cash,
          maxHealth: ranks.maxHealth,
        })
        .from(playerStats)
        .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
        .where(eq(playerStats.playerId, player.id));
      if (!stats) throw new PluginError("unauthorized", 401);
      const attrs = await tx.attributes.read(player.id);

      // Same resolution order as core's auth/routes.ts and hospital/status.ts:
      // the per-player health_max override (gym-trained, migration 0017) wins,
      // then the rank cap, then 100 — which matches core's `ranks.max_health`
      // column default and hospital's DEFAULT_MAX_HEALTH for a player with no
      // rank row. A plugin cannot import those constants from apps/server, so
      // the three sites must be kept in step by hand.
      const maxHealth = stats.healthMaxOverride ?? stats.maxHealth ?? 100;
      // Only the built-in heal refuses at full health. A def that grants exp
      // or pays out has nothing to do with health, and gating it on a full
      // health bar would make it unusable for no reason.
      if (use.kind === HEAL_EFFECT_KIND && stats.health >= maxHealth) {
        throw new PluginError("already_full", 409);
      }

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

      const snapshot = {
        health: stats.health,
        maxHealth,
        exp: Number(stats.exp),
        cash: stats.cash.toString(),
        pools: {
          energy: { value: attrs.energy, max: attrs.energyMax },
          will: { value: attrs.will, max: attrs.willMax },
          brave: { value: attrs.brave, max: attrs.braveMax },
        },
      };
      // The def is pure and third-party; `guardEffect` is what keeps its throw
      // a 400 rather than a 500, and `boundOutcome` is what keeps its figures
      // from minting health, exp or money.
      const outcome = guardEffect(use.kind, () => def.apply(use.config, snapshot));
      const bounded = boundOutcome(outcome, snapshot);

      if (bounded.health !== stats.health) {
        await tx.db
          .update(playerStats)
          .set({ health: bounded.health })
          .where(eq(playerStats.playerId, player.id));
      }
      if (bounded.expDelta !== 0n) {
        await tx.db
          .update(playerStats)
          .set({ exp: sql`${playerStats.exp} + ${bounded.expDelta}` })
          .where(eq(playerStats.playerId, player.id));
      }
      let cash = stats.cash;
      if (bounded.cashDelta !== 0n) {
        // NOTES.md rule 3: every balance movement goes through the ledger
        // path, the same one `POST /api/shop/buy` uses. `boundOutcome` has
        // already floored the debit at the player's own cash, so the
        // InsufficientFundsError arm shop/buy needs cannot be reached here.
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: bounded.cashDelta,
          kind: "cash",
          reason: `inventory.effect.${use.kind}`,
          refId: params.itemId,
        });
      }

      // Pool deltas go through tx.attributes — the one authority for pool
      // writes (clamp on grant, insufficient_<pool> 409 on a short spend).
      // A refused spend rolls this whole transaction back, the qty decrement
      // included, so an unaffordable item is never consumed. No lock of its
      // own: the tx.locks.player at the top of this transaction is the
      // contract tx.attributes documents.
      const touched = POOL_ORDER.filter((pool) => bounded.poolDeltas[pool] !== undefined);
      for (const pool of touched) {
        const delta = bounded.poolDeltas[pool] ?? 0;
        if (delta < 0) await tx.attributes.spend(player.id, pool, -delta);
        else await tx.attributes.grant(player.id, pool, delta);
      }
      let pools:
        | { energy: number; energyMax: number; will: number; willMax: number; brave: number; braveMax: number }
        | undefined;
      if (touched.length > 0) {
        const after = await tx.attributes.read(player.id);
        pools = {
          energy: after.energy, energyMax: after.energyMax,
          will: after.will, willMax: after.willMax,
          brave: after.brave, braveMax: after.braveMax,
        };
      }

      return {
        status: 200,
        body: {
          health: bounded.health,
          healed: bounded.healed,
          qty: remaining,
          exp: (stats.exp + bounded.expDelta).toString(),
          cash: cash.toString(),
          // Omitted rather than null when the def said nothing:
          // `exactOptionalPropertyTypes` makes the spread the honest form.
          ...(bounded.message !== null ? { message: bounded.message } : {}),
          ...(pools !== undefined ? { pools } : {}),
        },
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

/**
 * The melee form's discriminant. NOT a stored item type: a melee weapon is
 * `item_type = "weapon"` whose effects carry `power` — the marker combat's
 * `loadWeapon` and the melee-slot equip gate both read (C6). The form needs
 * its own discriminant because the firearm shape requires a damage range a
 * melee item never has; `storedItemType` maps it back before any row is
 * written or compared.
 */
const FORM_TYPE_MELEE = "melee";

/** Not blankable: "" coerces to 0, and a powerless melee weapon is not a
 *  weapon — unlike the firearm optionals there is no meaningful blank. */
const MeleeStatsShape = { power: z.coerce.number().int().positive() } as const;

function storedItemType(formType: string): string {
  return formType === FORM_TYPE_MELEE ? ITEM_TYPE_WEAPON : formType;
}

/**
 * `kind` names a def in the `inventory.itemEffects` registry; blank is the
 * built-in `heal`, which is what every existing item is. `heal` is blankable
 * for the same reason it became optional in `ConsumableEffectsSchema` — a
 * non-heal consumable has no heal figure — and `effectsFor` is what still
 * insists on one when the kind IS heal.
 *
 * There is deliberately no generic `meta` editor: `meta` arrives from the M4
 * migrator and is a def's non-editable config half.
 */
const ConsumableStatsShape = {
  heal: blankable(z.coerce.number().int().positive()),
  kind: blankable(z.string().min(1).max(40)),
} as const;

const ItemBodySchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal(ITEM_TYPE_WEAPON),
    name: z.string().min(1).max(80),
    ...WeaponStatsShape,
  }).strict(),
  z.object({
    itemType: z.literal(FORM_TYPE_MELEE),
    name: z.string().min(1).max(80),
    ...MeleeStatsShape,
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
    itemType: z.literal(FORM_TYPE_MELEE),
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    ...MeleeStatsShape,
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
  | ({ itemType: typeof FORM_TYPE_MELEE } & z.infer<z.ZodObject<typeof MeleeStatsShape>>)
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
      case FORM_TYPE_MELEE:
        return MeleeEffectsSchema.parse({ power: body.power });
      case ITEM_TYPE_ARMOR:
        return ArmorEffectsSchema.parse({ armor: body.armor });
      case ITEM_TYPE_CONSUMABLE: {
        // The built-in heal def refuses an item with no heal figure. Catching
        // that here makes it a 400 at authoring time rather than a `wrong_slot`
        // the first player to spend the item discovers.
        if (body.kind === undefined && body.heal === undefined) {
          throw new Error("a heal consumable needs a heal figure");
        }
        return ConsumableEffectsSchema.parse({
          ...(body.kind !== undefined && { kind: body.kind }),
          ...(body.heal !== undefined && { heal: body.heal }),
        });
      }
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
    critMultiplier: "", armorPierce: "", minRankExp: "", dps: "", power: "",
    armor: "", heal: "", effect: "",
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
      // Melee first, the same order readEffects itself checks: a melee row is
      // `{ power }`, which the firearm schema below REJECTS (no damage
      // range) — parsing it there used to throw and 500 the whole listing
      // the moment one imported melee item existed.
      const melee = MeleeEffectsSchema.safeParse(parsed);
      if (melee.success) return { ...blank, power: String(melee.data.power) };
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
    default: {
      const c = ConsumableEffectsSchema.parse(parsed);
      return {
        ...blank,
        // Em dash, like a weapon's absent accuracy: a non-heal consumable has
        // no heal figure, and "0" would read as one that heals nothing.
        heal: c.heal === undefined ? "—" : String(c.heal),
        // The kind the item selects in the effect registry. Whether a def for
        // it is installed is a runtime question this listing does not ask.
        effect: consumableKind(parsed) ?? HEAL_EFFECT_KIND,
      };
    }
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
        // "melee" is the FORM's discriminant only — the row stores "weapon".
        itemType: storedItemType(body.itemType),
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
      // Compared against the STORED type the form value maps to: melee and
      // firearm are both item_type "weapon", so pointing either weapon form
      // at the other converts the model — deliberate (both leave type and
      // effects agreeing, and combat degrades a non-melee row in the melee
      // slot to fists) — while an armor or consumable target still refuses.
      if (existing.itemType !== storedItemType(body.itemType)) return "mismatch" as const;
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

const adminItemDeleteRoute = route({
  method: "DELETE", path: "/api/admin/inventory/items/:id", auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const outcome = await ctx.transaction(async (tx) => {
      const [existing] = await tx.db.select({ id: items.id }).from(items).where(eq(items.id, params.id));
      if (!existing) return "not_found" as const;
      // `player_items.item_id` is ON DELETE CASCADE and the equip columns are
      // SET NULL — the database would vaporise every owned copy and silently
      // unequip every holder. Refused instead (the role_in_use shape): an
      // item still in someone's hands is not the admin's to destroy.
      const [owned] = await tx.db.select({ id: playerItems.playerId }).from(playerItems)
        .where(eq(playerItems.itemId, params.id)).limit(1);
      if (owned !== undefined) return "in_use" as const;
      const [equipped] = await tx.db.select({ id: playerStats.playerId }).from(playerStats)
        .where(sql`${playerStats.weaponItemId} = ${params.id} or ${playerStats.armorItemId} = ${params.id}`)
        .limit(1);
      if (equipped !== undefined) return "in_use" as const;
      // `p_inventory_shop_stock` carries NO foreign keys (its migration
      // predates none — it simply has none), so its rows for this item must
      // go explicitly or they orphan.
      await tx.db.delete(shopStock).where(eq(shopStock.itemId, params.id));
      await tx.db.delete(items).where(eq(items.id, params.id));
      return "ok" as const;
    });
    if (outcome === "not_found") throw new PluginError("item_not_found", 404);
    if (outcome === "in_use") throw new PluginError("item_in_use", 409);
    return { status: 204 };
  },
});

const adminShopDeleteRoute = route({
  method: "DELETE", path: "/api/admin/inventory/shop/:locationId/:itemId", auth: "admin",
  params: z.object({ locationId: z.string().uuid(), itemId: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      const result = await tx.db.delete(shopStock)
        .where(and(eq(shopStock.locationId, params.locationId), eq(shopStock.itemId, params.itemId)))
        .returning({ itemId: shopStock.itemId });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("stock_not_found", 404);
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

/**
 * Spread into both consumable forms for the same reason the weapon fields are:
 * the two must offer the same stats.
 *
 * `kind` is a free text field rather than a select. The registry is assembled
 * at request time from a filter chain, and the admin page's data sources are
 * plain routes — a select would need its own route running the chain, for a
 * value an operator installing a def already knows.
 */
const CONSUMABLE_STAT_FORM_FIELDS = [
  { name: "heal", label: "Heal (blank for a non-heal effect)", type: "number" },
  { name: "kind", label: "Effect kind (blank = heal)", type: "text" },
] as const satisfies readonly { name: string; label: string; type: "number" | "text" }[];

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
            { key: "power", label: "Power" },
            { key: "armor", label: "Armor" },
            { key: "heal", label: "Heal" },
            { key: "effect", label: "Effect" },
          ], rowActions: [
            { label: "Delete", action: "DELETE /api/admin/inventory/items/:id", confirm: "Delete this item? Refused while any player owns or wields one." },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add weapon", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_WEAPON },
            ...WEAPON_STAT_FORM_FIELDS,
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add melee weapon", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", type: "hidden", value: FORM_TYPE_MELEE },
            { name: "power", label: "Power", type: "number" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add armor", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_ARMOR },
            { name: "armor", label: "Armor", type: "number" },
          ] },
          { kind: "form", action: "POST /api/admin/inventory/items", submitLabel: "Add consumable", fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "itemType", type: "hidden", value: ITEM_TYPE_CONSUMABLE },
            ...CONSUMABLE_STAT_FORM_FIELDS,
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
          { kind: "form", action: "POST /api/admin/inventory/items/update", submitLabel: "Update melee weapon", fields: [
            { name: "id", label: "Item", type: "select", optionsSource: "GET /api/admin/inventory/items", valueKey: "id", labelKey: "name" },
            { name: "itemType", type: "hidden", value: FORM_TYPE_MELEE },
            { name: "name", label: "Rename to (optional)", type: "text" },
            { name: "power", label: "Power", type: "number" },
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
            ...CONSUMABLE_STAT_FORM_FIELDS,
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
          ], rowActions: [
            // Composite key: the shop row has no single id, so the action
            // names both halves and the renderer fills each from the row.
            { label: "Delete", action: "DELETE /api/admin/inventory/shop/:locationId/:itemId", confirm: "Remove this shop listing?" },
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

export { itemPriceAt } from "./pricing.js";

/**
 * The open item effect registry. A plugin adds an effect by subscribing to
 * `itemEffects` with a def whose `apply` is pure — the way `bounties`
 * subscribes to combat's `killResolved` and a casino game registers through
 * `casino.games`.
 *
 * The bounding half (`boundOutcome` and its caps) is exported for tests and
 * for anyone auditing what a def can and cannot do; nothing outside this
 * plugin needs to call it, because the use route is the only place a def runs.
 */
export {
  boundOutcome,
  buildEffectRegistry,
  consumableKind,
  guardEffect,
  HEAL_EFFECT,
  HEAL_EFFECT_KIND,
  itemEffects,
  MAX_CASH_PER_USE,
  MAX_EXP_PER_USE,
  MIN_HEALTH_AFTER_USE,
  POOL_ORDER,
  POOLS_EFFECT,
  POOLS_EFFECT_KIND,
  readConsumableUse,
  type BoundedOutcome,
  type ConsumableUse,
  type ItemEffectDef,
  type ItemEffectOutcome,
  type ItemEffectSnapshot,
  type PoolSnapshot,
} from "./effect-registry.js";

export default definePlugin({
  id: "inventory",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/inventory", "/api/shop", "/api/admin/inventory"],
  tables: { shopStock: "p_inventory_shop_stock" },
  migrations: SHOP_MIGRATIONS,
  routes: [
    listRoute, equipRoute, useRoute, shopListRoute, shopBuyRoute,
    adminItemListRoute, adminItemCreateRoute, adminItemUpdateRoute, adminItemDeleteRoute,
    adminShopListRoute, adminShopUpsertRoute, adminShopDeleteRoute,
    adminLocationListRoute,
  ],
  events: [purchasedEvent],
  provides: [itemActions, itemEffects],
  // No `menu`, `pages` or `jobs`: plugin-manifest-endpoint.test.ts:87 asserts
  // a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }, and buildApp throws at boot if a
  // core plugin declares jobs. `adminPages` is not `pages` — it is served
  // separately by GET /api/admin/plugins and never reaches that payload.
  adminPages: [adminPage],
});
