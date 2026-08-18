import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

export const RankDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  expRequired: MoneySchema,
  cashReward: MoneySchema,
  bulletReward: z.number().int().nonnegative(),
  maxHealth: z.number().int().positive(),
  current: z.boolean(),
  /** Absent when no badge is bound — see `InventoryItemSchema.imageUrl`. */
  imageUrl: z.string().optional(),
});
export type RankDto = z.infer<typeof RankDtoSchema>;

export const MoneyRankDtoSchema = z.object({
  id: IdSchema,
  label: z.string(),
  threshold: MoneySchema,
});
export type MoneyRankDto = z.infer<typeof MoneyRankDtoSchema>;

export const RankListResponseSchema = z.object({
  ranks: z.array(RankDtoSchema),
  moneyRanks: z.array(MoneyRankDtoSchema),
});
export type RankListResponse = z.infer<typeof RankListResponseSchema>;
