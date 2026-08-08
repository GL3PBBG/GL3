import { z } from "zod";
import { MoneySchema } from "../primitives.js";

export const BuyBulletsRequestSchema = z.object({ quantity: z.number().int().positive() });
export type BuyBulletsRequest = z.infer<typeof BuyBulletsRequestSchema>;

export const BuyBulletsResponseSchema = z.object({
  cash: MoneySchema, bullets: MoneySchema, bulletStock: z.number().int().nonnegative(),
});
export type BuyBulletsResponse = z.infer<typeof BuyBulletsResponseSchema>;
