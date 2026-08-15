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
 * Only the damage range is REQUIRED. Every other weapon field either defaults
 * here or, in accuracy's case, is optional — V2's `itemEffects` has no
 * accuracy column, so a migrated item arrives without one and must still
 * parse. Combat fills an absent accuracy from `combat.default_weapon_accuracy`
 * (`index.ts`, `loadWeapon`); this schema deliberately does not, because the
 * default is a combat tuning knob and a schema has no settings access.
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
