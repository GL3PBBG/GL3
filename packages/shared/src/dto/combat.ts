import { z } from "zod";
import { MoneySchema } from "../primitives.js";

/**
 * Why a target cannot be shot — combat's own legality answers. `null` when
 * they can be. `target_elsewhere` is absent from this union because such a
 * player is simply not in the list.
 */
export const TargetReasonSchema = z.enum([
  "hospitalised", "jailed", "gang_mate", "newbie_protected", "newbie_self",
]);
export type TargetReason = z.infer<typeof TargetReasonSchema>;

/** Per-town combat rule — mirrors core `locations.combat_mode`. */
export const CombatModeSchema = z.enum(["open", "underground"]);
export type CombatMode = z.infer<typeof CombatModeSchema>;

export const CombatTargetSchema = z.object({
  playerId: z.string().uuid(),
  username: z.string(),
  rank: z.string().nullable(),
  health: z.number().int(),
  maxHealth: z.number().int(),
  attackable: z.boolean(),
  reason: TargetReasonSchema.nullable(),
});
export type CombatTarget = z.infer<typeof CombatTargetSchema>;

export const CombatTargetListResponseSchema = z.object({
  /** `underground` towns list only players the caller holds an active detective report on. */
  mode: CombatModeSchema,
  targets: z.array(CombatTargetSchema),
});
export type CombatTargetListResponse = z.infer<typeof CombatTargetListResponseSchema>;

export const WeaponUsedSchema = z.enum(["firearm", "melee", "fists"]);
export type WeaponUsed = z.infer<typeof WeaponUsedSchema>;

export const AttackResponseSchema = z.object({
  hit: z.boolean(),
  crit: z.boolean(),
  damage: z.number().int(),
  armorAbsorbed: z.number().int(),
  targetHealth: z.number().int(),
  targetKilled: z.boolean(),
  payout: MoneySchema,
  bulletsSpent: z.number().int(),
  /** True when the weapon went off in the attacker's hand: no miss, no hit. */
  backfire: z.boolean(),
  /** Damage the attacker took from their own weapon. 0 unless `backfire`. */
  selfDamage: z.number().int().nonnegative(),
  /** The attacker's health after the shot, so the client need not refetch. */
  attackerHealth: z.number().int().nonnegative(),
  /** Which model resolved the action — the melee slot, slot 1's gun, or bare hands. */
  weapon: WeaponUsedSchema,
  /** The item that fired, by name; null for fists. */
  weaponName: z.string().nullable(),
});
export type AttackResponse = z.infer<typeof AttackResponseSchema>;

/**
 * The optional body of `POST /api/combat/attack/:targetId`. Absent keeps the
 * server's precedence (slot 1 when armed, else the melee slot, else fists);
 * `melee` insists on the melee slot and 409s `no_melee_weapon` when it is
 * empty; `firearm` is slot 1, fists included.
 */
export const WeaponChoiceSchema = z.enum(["firearm", "melee"]);
export type WeaponChoice = z.infer<typeof WeaponChoiceSchema>;
export const AttackRequestSchema = z.object({ weapon: WeaponChoiceSchema.optional() });
export type AttackRequest = z.infer<typeof AttackRequestSchema>;

export const CombatLogEntrySchema = z.object({
  id: z.string().uuid(),
  attackerId: z.string().uuid(),
  targetId: z.string().uuid(),
  hit: z.boolean(),
  damage: z.number().int(),
  fatal: z.boolean(),
  payout: MoneySchema,
  createdAt: z.string(),
});
export type CombatLogEntry = z.infer<typeof CombatLogEntrySchema>;

export const CombatLogResponseSchema = z.object({
  entries: z.array(CombatLogEntrySchema),
});
export type CombatLogResponse = z.infer<typeof CombatLogResponseSchema>;

export const FirearmSlotDtoSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string(),
  damageMin: z.number().int().nonnegative(),
  damageMax: z.number().int().nonnegative(),
  bulletsPerShot: z.number().int().positive(),
});
export type FirearmSlotDto = z.infer<typeof FirearmSlotDtoSchema>;

/**
 * The melee slot with one honest figure: `estimate` is the strike's raw
 * damage against an unguarded, unarmored target with no swing and no crit
 * (`power × strength × 1.5`). Real damage divides by the target's guard,
 * which the server cannot know at read time, so a page must label it as a
 * ceiling, never a range. `strength` and `estimate` are bigint on the
 * server and cross as decimal strings like every other bigint.
 */
export const MeleeSlotDtoSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string(),
  power: z.number().int().positive(),
  strength: z.string().regex(/^\d+$/),
  estimate: z.string().regex(/^\d+$/),
});
export type MeleeSlotDto = z.infer<typeof MeleeSlotDtoSchema>;

export const FistsDtoSchema = z.object({
  power: z.number().int().positive(),
  strength: z.string().regex(/^\d+$/),
  estimate: z.string().regex(/^\d+$/),
});
export type FistsDto = z.infer<typeof FistsDtoSchema>;

/**
 * The equipped weapon's wear, for the combat page. Every field is nullable or
 * zero when nothing is equipped: fists have no condition and never backfire.
 */
export const WeaponConditionDtoSchema = z.object({
  itemId: z.string().uuid().nullable(),
  name: z.string().nullable(),
  condition: z.number().int().min(0).max(100),
  backfireChance: z.number().int().min(0).max(100),
  repairCost: MoneySchema,
  /**
   * Slot 1 described as a gun, or null when it is empty or does not parse as
   * a firearm. The five fields above stay slot 1's condition report exactly
   * as they were; this block is what the page shows beside them.
   */
  firearm: FirearmSlotDtoSchema.nullable(),
  /** The melee slot, or null when empty. */
  melee: MeleeSlotDtoSchema.nullable(),
  /**
   * Bare hands under the melee unarmed model (`combat.unarmed.model`), the
   * same arithmetic as the melee slot's estimate; null under the firearm
   * model. Present whether or not a slot is armed: it describes the fallback.
   */
  fists: FistsDtoSchema.nullable(),
});
export type WeaponConditionDto = z.infer<typeof WeaponConditionDtoSchema>;

export const RepairResponseSchema = z.object({
  condition: z.number().int().min(0).max(100),
  cost: MoneySchema,
});
export type RepairResponse = z.infer<typeof RepairResponseSchema>;
