import { z } from "zod";
import { IdSchema } from "../primitives.js";

export const OnlineEntrySchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  /** null when the player stands in an underground town — name shown, town concealed. */
  locationName: z.string().nullable(),
  lastActiveAt: z.string(),
});
export type OnlineEntry = z.infer<typeof OnlineEntrySchema>;

export const OnlineListResponseSchema = z.object({
  onlineNow: z.array(OnlineEntrySchema),
  lastHour: z.array(OnlineEntrySchema),
});
export type OnlineListResponse = z.infer<typeof OnlineListResponseSchema>;
