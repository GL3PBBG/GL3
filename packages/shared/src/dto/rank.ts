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
});
export type RankDto = z.infer<typeof RankDtoSchema>;

export const RankListResponseSchema = z.object({ ranks: z.array(RankDtoSchema) });
export type RankListResponse = z.infer<typeof RankListResponseSchema>;
