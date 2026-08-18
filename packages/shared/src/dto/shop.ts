import { z } from "zod";
import { MoneySchema } from "../primitives.js";

export const ShopItemSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string(),
  itemType: z.string(),
  effects: z.unknown(),
  price: MoneySchema,
  stock: z.number().int().nonnegative(),
  /** Absent when no art is bound — see `InventoryItemSchema.imageUrl`. */
  imageUrl: z.string().optional(),
});
export type ShopItem = z.infer<typeof ShopItemSchema>;

export const ShopListResponseSchema = z.object({
  locationId: z.string().uuid(),
  items: z.array(ShopItemSchema),
});
export type ShopListResponse = z.infer<typeof ShopListResponseSchema>;

export const BuyItemRequestSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().int().positive(),
});
export type BuyItemRequest = z.infer<typeof BuyItemRequestSchema>;

export const BuyItemResponseSchema = z.object({
  cash: MoneySchema,
  itemId: z.string().uuid(),
  qty: z.number().int(),
  stock: z.number().int().nonnegative(),
});
export type BuyItemResponse = z.infer<typeof BuyItemResponseSchema>;
