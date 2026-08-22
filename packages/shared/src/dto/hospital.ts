import { z } from "zod";
import { MoneySchema } from "../primitives.js";

/** Mirrors `GET /api/hospital` (apps/server/src/game/hospital/routes.ts:49). */
export const HospitalStatusSchema = z.object({
  health: z.number().int(),
  maxHealth: z.number().int(),
  hospitalised: z.boolean(),
  until: z.string().nullable(),
  remainingSeconds: z.number().int().nonnegative(),
  /** Buy-out quote for the CALLER's own stay — wealth-scaled on their cash + bank. */
  dischargeCost: MoneySchema,
});
export type HospitalStatus = z.infer<typeof HospitalStatusSchema>;

export const DischargeResponseSchema = z.object({
  health: z.number().int(),
  cash: MoneySchema,
  paid: MoneySchema,
});
export type DischargeResponse = z.infer<typeof DischargeResponseSchema>;

/** One patient in the caller's current town. Mirrors `GET /api/hospital/local`. */
export const HospitalPatientSchema = z.object({
  playerId: z.string().uuid(),
  username: z.string(),
  rankName: z.string(),
  until: z.string(),
  remainingSeconds: z.number().int().nonnegative(),
  /** What it would cost THE CALLER to pay this patient out — wealth-scaled on the caller. */
  dischargeCost: MoneySchema,
});
export type HospitalPatient = z.infer<typeof HospitalPatientSchema>;

export const WardListResponseSchema = z.object({ patients: z.array(HospitalPatientSchema) });
export type WardListResponse = z.infer<typeof WardListResponseSchema>;

/** `POST /api/hospital/checkin` answers with the same shape as `GET /api/hospital`. */
export const CheckinResponseSchema = HospitalStatusSchema;
export type CheckinResponse = z.infer<typeof CheckinResponseSchema>;

/** `POST /api/hospital/discharge-player` — pays another patient out. */
export const DischargePlayerResponseSchema = z.object({
  freed: z.string().uuid(),
  paid: MoneySchema,
  cash: MoneySchema,
});
export type DischargePlayerResponse = z.infer<typeof DischargePlayerResponseSchema>;
