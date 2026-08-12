import { z } from "zod";
import { MoneySchema } from "../primitives.js";

/** Mirrors `GET /api/hospital` (apps/server/src/game/hospital/routes.ts:49). */
export const HospitalStatusSchema = z.object({
  health: z.number().int(),
  maxHealth: z.number().int(),
  hospitalised: z.boolean(),
  until: z.string().nullable(),
  remainingSeconds: z.number().int().nonnegative(),
  dischargeCost: MoneySchema,
});
export type HospitalStatus = z.infer<typeof HospitalStatusSchema>;

export const DischargeResponseSchema = z.object({
  health: z.number().int(),
  cash: MoneySchema,
  paid: MoneySchema,
});
export type DischargeResponse = z.infer<typeof DischargeResponseSchema>;
