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
}).refine((e) => e.damageMax >= e.damageMin, {
  message: "damageMax must be >= damageMin",
});

export const ArmorEffectsSchema = z.object({
  armor: z.number().int().nonnegative(),
});

export const ConsumableEffectsSchema = z.object({
  heal: z.number().int().positive(),
});

export type WeaponEffects = z.infer<typeof WeaponEffectsSchema>;
export type ArmorEffects = z.infer<typeof ArmorEffectsSchema>;
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
