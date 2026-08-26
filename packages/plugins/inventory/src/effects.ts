import { z } from "zod";

/**
 * `items.effects` is jsonb, so it is an external boundary and is zod-parsed on
 * every read — never trusted raw.
 *
 * Only the damage range is REQUIRED. Every other weapon field either defaults
 * here or, in accuracy's case, is optional — V2's `itemEffects` has no
 * accuracy column, so a migrated item arrives without one and must still
 * parse. A listing therefore omits accuracy for such an item rather than
 * inventing one: combat fills it from `combat.default_weapon_accuracy` when
 * the weapon is actually fired, and that setting is not this plugin's to read.
 *
 * Absent is not the same as zero here: a weapon that really does state
 * `accuracy: 0` never hits, and that must survive the round trip.
 */
export const WeaponEffectsSchema = z.object({
  accuracy: z.number().int().min(0).max(100).optional(),
  damageMin: z.number().int().nonnegative(),
  damageMax: z.number().int().nonnegative(),
  bulletsPerShot: z.number().int().positive().default(1),
  critChance: z.number().int().min(0).max(100).default(0),
  /** A float, and the only one. Damage stays integer: floor(damage × this). */
  critMultiplier: z.number().min(1).default(1),
  armorPierce: z.number().int().nonnegative().default(0),
  /**
   * An exp threshold, not a rank id. Ranks are UUID rows ordered by
   * exp_required, so "rank >= X" is really an exp comparison — this compares
   * against player_stats.exp directly, with no join and no dangling pointer
   * when an admin edits or deletes a rank row.
   */
  minRankExp: z.number().int().nonnegative().default(0),
  /**
   * Optional for the same reason `accuracy` is: a migrated V2 item has no
   * such column and must still parse. Combat fills an absent value from
   * `combat.backfire.base_chance`. An explicit 0 means "never backfires" and
   * must survive the round trip — do not collapse it to the default.
   */
  backfireChance: z.number().int().min(0).max(100).optional(),
  /**
   * Damage per second the weapon may sustain, and the second float here after
   * `critMultiplier`. Combat divides the weapon's average damage by it to get
   * the attack cooldown (`cooldown.ts`), so 10 damage at 1 dps is a 10-second
   * wait and at 0.5 dps a 20-second one.
   *
   * Optional for the same reason `accuracy` and `backfireChance` are: no
   * migrated V2 item carries one, and those keep the flat
   * `combat.cooldown_seconds` instead. Positive, not just non-negative — zero
   * is a division by zero, and an absent field already means "unpaced".
   */
  dps: z.number().positive().optional(),
}).refine((e) => e.damageMax >= e.damageMin, {
  message: "damageMax must be >= damageMin",
});

export const ArmorEffectsSchema = z.object({
  armor: z.number().int().nonnegative(),
});

/**
 * A melee weapon's whole effects (C6's marker, B0's slot gate): `power` IS
 * the melee model — such an item carries no damage range for the firearm
 * schema above to require, which is what makes the two models unambiguous.
 * Combat resolves it as power × strength ÷ (guard/1.5); the equip route
 * allows only this shape into the melee slot.
 */
export const MeleeEffectsSchema = z.object({
  power: z.number().int().positive(),
});

/**
 * OPEN, unlike the weapon and armor schemas: a consumable's effects name a
 * `kind` in the `inventory.itemEffects` registry and carry whatever config
 * that kind's def reads, so this plugin cannot enumerate the keys. `.passthrough()`
 * is what lets a third-party def's config survive the round trip to the client.
 *
 * `heal` is still declared — it is the built-in def's whole config and every
 * existing item's only key — but optional now, because a non-heal consumable
 * has no heal figure. An absent `kind` means `heal`; see `consumableKind`.
 */
export const ConsumableEffectsSchema = z.object({
  kind: z.string().min(1).optional(),
  heal: z.number().int().positive().optional(),
}).passthrough();

export type WeaponEffects = z.infer<typeof WeaponEffectsSchema>;
export type ArmorEffects = z.infer<typeof ArmorEffectsSchema>;
export type MeleeEffects = z.infer<typeof MeleeEffectsSchema>;
export type ConsumableEffects = z.infer<typeof ConsumableEffectsSchema>;

export const ITEM_TYPE_WEAPON = "weapon";
export const ITEM_TYPE_ARMOR = "armor";
export const ITEM_TYPE_CONSUMABLE = "consumable";

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
export function readEffects(itemType: string, effects: unknown): unknown {
  switch (itemType) {
    case ITEM_TYPE_WEAPON: {
      // Melee first, matching combat's loadWeapon: `power` is the melee
      // marker and such items fail the firearm schema below (no damage
      // range) — without this branch a melee weapon would list as `null`,
      // "unusable", when it is the one item type the melee slot accepts.
      const melee = MeleeEffectsSchema.safeParse(effects);
      if (melee.success) return melee.data;
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
