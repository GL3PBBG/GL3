import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

/**
 * Mirrors POST/GET/DELETE /api/detectives (packages/plugins/detectives).
 * Timestamps are ISO strings, same convention as the bounties DTO.
 */
export const HireDetectivesRequestSchema = z.object({
  targetUsername: z.string().min(1).max(30),
  detectives: z.number().int().min(1).max(5),
  hours: z.number().int().min(1).max(5),
});
export type HireDetectivesRequest = z.infer<typeof HireDetectivesRequestSchema>;

export const HireDetectivesResponseSchema = z.object({
  searchId: IdSchema,
  cash: MoneySchema,
});
export type HireDetectivesResponse = z.infer<typeof HireDetectivesResponseSchema>;

export const DetectiveSearchRowSchema = z.object({
  id: IdSchema,
  targetId: IdSchema,
  targetUsername: z.string(),
  detectives: z.number().int(),
  startedAt: z.string(),
  endsAt: z.string(),
  expiresAt: z.string(),
  /** null while pending — the server never reveals the roll before endsAt. */
  succeeded: z.boolean().nullable(),
  targetLocationId: IdSchema.nullable(),
  targetLocationName: z.string().nullable(),
});
export type DetectiveSearchRow = z.infer<typeof DetectiveSearchRowSchema>;

export const DetectiveListResponseSchema = z.object({
  /** Unit cost for THIS caller — wealth-scaled; the client previews cost x detectives x hours. */
  cost: MoneySchema,
  /**
   * Seconds one duration unit lasts — V2's `detectiveDuration`. The 1–5
   * "hours" dropdown is really a unit count; the client labels it from this
   * ("1 hour" at 3600, "1 second" at V2's shipped default of 1).
   */
  durationSeconds: z.number().int().positive(),
  searches: z.array(DetectiveSearchRowSchema),
});
export type DetectiveListResponse = z.infer<typeof DetectiveListResponseSchema>;

export const RemoveDetectiveSearchResponseSchema = z.object({ removed: z.boolean() });
export type RemoveDetectiveSearchResponse = z.infer<typeof RemoveDetectiveSearchResponseSchema>;
