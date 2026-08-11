import { z } from "zod";

/**
 * A VERBATIM COPY of `packages/plugins/inventory/src/effects.ts`. A plugin may
 * not import another plugin, and both need to read the same `items.effects`
 * blob — inventory to show a weapon's stats, combat to fire it. The two files
 * must be kept in step by hand: a field added there and not here means combat
 * silently ignores a stat the player can see in their inventory.
 *
 * `items.effects` is jsonb, so it is an external boundary and is zod-parsed on
 * every read — never trusted raw.
 *
 * Every weapon field except accuracy and the damage range DEFAULTS, so a
 * migrated V2 item that carried only `damage` (V2's itemEffects has no
 * accuracy, no range, and none of the rest) parses without backfill.
 */
export const WeaponEffectsSchema = z.object({
  accuracy: z.number().int().min(0).max(100),
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
