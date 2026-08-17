import { z } from "zod";
import { MoneySchema } from "../primitives.js";

export const BuyBulletsRequestSchema = z.object({ quantity: z.number().int().positive() });
export type BuyBulletsRequest = z.infer<typeof BuyBulletsRequestSchema>;

export const BuyBulletsResponseSchema = z.object({
  cash: MoneySchema, bullets: MoneySchema, bulletStock: z.number().int().nonnegative(),
});
export type BuyBulletsResponse = z.infer<typeof BuyBulletsResponseSchema>;

/**
 * `GET /api/bullets/shop`. The page's own read, replacing the stock it used to
 * take from the locations list: `unitCost` is the price the buy route will
 * actually charge (the factory owner's lever when one is set, capped by the
 * admin's `max_cost`), which the location row does not know. Reading it is
 * also what triggers the hourly restock.
 *
 * `maxBuy` is null when the admin has set no per-purchase cap.
 */
export const BulletShopResponseSchema = z.object({
  locationId: z.string().uuid(),
  locationName: z.string(),
  bulletStock: z.number().int().nonnegative(),
  unitCost: MoneySchema,
  maxBuy: z.number().int().nonnegative().nullable(),
  bullets: MoneySchema,
});
export type BulletShopResponse = z.infer<typeof BulletShopResponseSchema>;
