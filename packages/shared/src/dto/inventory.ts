import { z } from "zod";
import { ItemActionSchema } from "./extensions.js";

/**
 * `effects` is `unknown` on purpose. The server passes it through
 * `readEffects`, which returns the parsed shape for the three known item types
 * and the raw jsonb untouched for any other — `item_type` is unconstrained text
 * and V2 shipped types beyond these three. Narrowing it here would mean
 * changing a shipped route's contract; the web side pulls numbers out through
 * `lib/effects.ts` instead.
 */
export const InventoryItemSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string(),
  itemType: z.string(),
  effects: z.unknown(),
  qty: z.number().int(),
  /**
   * Absent when no art is bound, which is the normal state of an item nobody
   * has uploaded a picture for. Optional rather than nullable so a server that
   * predates game art still parses.
   */
  imageUrl: z.string().optional(),
  /**
   * Plugin-contributed links from the `inventory.itemActions` filter point
   * (e.g. combat's gunsmith repair link on a weapon). Optional rather than a
   * bare array so a server that predates the extension surface still parses.
   */
  actions: z.array(ItemActionSchema).optional(),
  /**
   * A consumable's effect label, resolved server-side from the
   * `inventory.itemEffects` registry — the `label` of whichever def its
   * `effects.kind` selects. Absent on every non-consumable, on a plain heal
   * item (the page already knows how to say "heals 20"), and on a consumable
   * naming a kind this deployment has no def for, where the page falls back to
   * the raw kind rather than inventing a name.
   */
  effectLabel: z.string().optional(),
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const InventoryResponseSchema = z.object({
  items: z.array(InventoryItemSchema),
  equipped: z.object({
    weaponItemId: z.string().uuid().nullable(),
    armorItemId: z.string().uuid().nullable(),
  }),
});
export type InventoryResponse = z.infer<typeof InventoryResponseSchema>;

/**
 * `.nullable().optional()` on both, mirroring the route: an absent key leaves
 * the slot alone, an explicit `null` unequips it. They must not collapse.
 */
export const EquipRequestSchema = z.object({
  weaponItemId: z.string().uuid().nullable().optional(),
  armorItemId: z.string().uuid().nullable().optional(),
});
export type EquipRequest = z.infer<typeof EquipRequestSchema>;

export const EquipResponseSchema = z.object({
  weaponItemId: z.string().uuid().nullable(),
  armorItemId: z.string().uuid().nullable(),
});
export type EquipResponse = z.infer<typeof EquipResponseSchema>;

export const UseItemResponseSchema = z.object({
  health: z.number().int(),
  healed: z.number().int(),
  qty: z.number().int(),
  /**
   * The three below are `.optional()` rather than required so a server that
   * predates the item effect registry still parses. `exp` and `cash` are the
   * player's totals AFTER the use — decimal strings, since both are bigint
   * columns. `message` is the def's own line, shown next to the Use button;
   * the server truncates it, and it is rendered as text, never as markup.
   */
  exp: z.string().optional(),
  cash: z.string().optional(),
  message: z.string().optional(),
});
export type UseItemResponse = z.infer<typeof UseItemResponseSchema>;
