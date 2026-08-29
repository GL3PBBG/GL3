import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";
import { CombatModeSchema } from "./combat.js";

export const LocationDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  travelCost: MoneySchema,
  travelCooldownSeconds: z.number().int().nonnegative(),
  bulletCost: MoneySchema,
  bulletStock: z.number().int().nonnegative(),
  current: z.boolean(),
  cooldownRemaining: z.number().int().nonnegative(),
  /** Absent when no town image is bound — see `InventoryItemSchema.imageUrl`. */
  imageUrl: z.string().optional(),
  combatMode: CombatModeSchema,
  /** The town's level gate (0 = open). Travel refuses below it; the list shows it so the lock is a teaser, not a surprise. */
  minLevel: z.number().int().nonnegative(),
});
export type LocationDto = z.infer<typeof LocationDtoSchema>;

export const LocationListResponseSchema = z.object({ locations: z.array(LocationDtoSchema) });
export type LocationListResponse = z.infer<typeof LocationListResponseSchema>;

export const TravelResponseSchema = z.object({ locationId: IdSchema, cash: MoneySchema });
export type TravelResponse = z.infer<typeof TravelResponseSchema>;
