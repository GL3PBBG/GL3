import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

export const CrimeDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  cooldownSeconds: z.number().int().nonnegative(),
  minPayout: MoneySchema,
  maxPayout: MoneySchema,
  /**
   * This player's current success chance, as a percentage string, e.g.
   * "35.00". NULL for a formula crime (B0): its chance is computed per
   * attempt from the player's stats by the sandboxed success_formula
   * dialect, so no static per-player number exists to list.
   */
  chance: z.string().nullable(),
  /** Seconds until this player may commit again; 0 when ready. */
  cooldownRemaining: z.number().int().nonnegative(),
  /** Absent when no art is bound — see `InventoryItemSchema.imageUrl`. */
  imageUrl: z.string().optional(),
});
export type CrimeDto = z.infer<typeof CrimeDtoSchema>;

export const CrimeListResponseSchema = z.object({ crimes: z.array(CrimeDtoSchema) });
export type CrimeListResponse = z.infer<typeof CrimeListResponseSchema>;

/** 202 Accepted — the outcome arrives over WS, not in this response body. */
export const CommitCrimeResponseSchema = z.object({ jobId: z.string(), accepted: z.literal(true) });
export type CommitCrimeResponse = z.infer<typeof CommitCrimeResponseSchema>;
