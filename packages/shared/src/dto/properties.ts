import { z } from "zod";

/**
 * Mirrors the plugin's GET /api/properties rows — every value a string.
 *
 * `price` is "" when the row's type is not declared by any installed plugin:
 * there is no price, so the row is not buyable. `lever` and `profit` are ""
 * for anyone who is not the owner — the lever and the P&L are the owner's
 * business only.
 */
export const PropertyRowSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  pluginId: z.string(),
  typeName: z.string(),
  price: z.string(),
  leverLabel: z.string(),
  ownerName: z.string(),
  lever: z.string(),
  profit: z.string(),
  /** The property TYPE's art, "" when the type has none bound. */
  imageUrl: z.string(),
});
export type PropertyRow = z.infer<typeof PropertyRowSchema>;

export const PropertyListResponseSchema = z.object({ rows: z.array(PropertyRowSchema) });
export type PropertyListResponse = z.infer<typeof PropertyListResponseSchema>;
