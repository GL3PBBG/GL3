import { z } from "zod";

/** Mirrors the plugin's GET /api/properties rows — every value a string. */
export const PropertyRowSchema = z.object({
  id: z.string(),
  locationName: z.string(),
  pluginId: z.string(),
  rate: z.string(),
  ownerName: z.string(),
  cost: z.string(),
  accrued: z.string(),
});
export type PropertyRow = z.infer<typeof PropertyRowSchema>;

export const PropertyListResponseSchema = z.object({ rows: z.array(PropertyRowSchema) });
export type PropertyListResponse = z.infer<typeof PropertyListResponseSchema>;
