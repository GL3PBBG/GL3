import { z } from "zod";
import { MoneySchema, TimestampSchema } from "../primitives.js";

export const JailStatusSchema = z.object({
  jailed: z.boolean(),
  until: TimestampSchema.nullable(),
  remainingSeconds: z.number().int().nonnegative(),
  /** V2 jail.inc.php's super max — a live sentence blocking the next escape/bust attempt (2026-08-31 spec §2). */
  superMax: z.boolean(),
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
  /** Whether THIS inmate is currently super-maxed — blocks a bust/bail choice. */
  superMax: z.boolean(),
  /** CALLER-relative breakout chance (`breakoutPercent`) — the client never re-derives the formula. */
  percent: z.number().int().min(0).max(100),
});
export type JailInmate = z.infer<typeof JailInmateSchema>;

export const CellBlockListResponseSchema = z.object({ inmates: z.array(JailInmateSchema) });
export type CellBlockListResponse = z.infer<typeof CellBlockListResponseSchema>;

export const BailResponseSchema = z.object({ freed: z.string().uuid(), paid: MoneySchema, cash: MoneySchema });
export type BailResponse = z.infer<typeof BailResponseSchema>;

/**
 * `jailedUntil` is the CALLER's new sentence — non-null only when the bust
 * failed. `superMax` is `true` only on escape's fail arm (V2's co-expiring
 * super max, 2026-08-31 spec §2) — escape reuses this shape; bust never sets it.
 */
export const BustResponseSchema = z.object({
  success: z.boolean(),
  jailedUntil: TimestampSchema.nullable(),
  superMax: z.boolean().optional(),
});
export type BustResponse = z.infer<typeof BustResponseSchema>;
