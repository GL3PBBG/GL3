import { z } from "zod";
import { IdSchema } from "../primitives.js";

export const PlayerSearchEntrySchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  /** null for an unranked player — the join to `ranks` is a left join. */
  rankName: z.string().nullable(),
});
export type PlayerSearchEntry = z.infer<typeof PlayerSearchEntrySchema>;

/** No location field, deliberately: an underground town's residents are
 *  concealed everywhere else (online.ts, combat targets), and a name search
 *  must not be the seam that leaks them. */
export const PlayerSearchResponseSchema = z.object({
  players: z.array(PlayerSearchEntrySchema),
});
export type PlayerSearchResponse = z.infer<typeof PlayerSearchResponseSchema>;
