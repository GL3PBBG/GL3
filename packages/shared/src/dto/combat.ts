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
  targets: z.array(CombatTargetSchema),
});
export type CombatTargetListResponse = z.infer<typeof CombatTargetListResponseSchema>;

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
});
export type AttackResponse = z.infer<typeof AttackResponseSchema>;

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
});
export type WeaponConditionDto = z.infer<typeof WeaponConditionDtoSchema>;

export const RepairResponseSchema = z.object({
  condition: z.number().int().min(0).max(100),
  cost: MoneySchema,
});
export type RepairResponse = z.infer<typeof RepairResponseSchema>;
