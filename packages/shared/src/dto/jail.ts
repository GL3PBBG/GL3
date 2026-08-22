import { z } from "zod";
import { MoneySchema, TimestampSchema } from "../primitives.js";

export const JailStatusSchema = z.object({
  jailed: z.boolean(),
  until: TimestampSchema.nullable(),
  remainingSeconds: z.number().int().nonnegative(),
});
export type JailStatus = z.infer<typeof JailStatusSchema>;

export const JailInmateSchema = z.object({
  playerId: z.string().uuid(),
  username: z.string(),
  rankName: z.string(),
  until: z.string(),
  remainingSeconds: z.number().int().nonnegative(),
  /** What bail would cost THE CALLER — wealth-scaled, so two viewers see different prices. */
  bailCost: MoneySchema,
});
export type JailInmate = z.infer<typeof JailInmateSchema>;

export const CellBlockListResponseSchema = z.object({ inmates: z.array(JailInmateSchema) });
export type CellBlockListResponse = z.infer<typeof CellBlockListResponseSchema>;

export const BailResponseSchema = z.object({ freed: z.string().uuid(), paid: MoneySchema, cash: MoneySchema });
export type BailResponse = z.infer<typeof BailResponseSchema>;

/** `jailedUntil` is the CALLER's new sentence — non-null only when the bust failed. */
export const BustResponseSchema = z.object({
  success: z.boolean(),
  jailedUntil: TimestampSchema.nullable(),
});
export type BustResponse = z.infer<typeof BustResponseSchema>;
