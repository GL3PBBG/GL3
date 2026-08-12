import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

/**
 * Mirrors POST /api/bounties and GET /api/bounties (packages/plugins/bounties).
 *
 * `createdAt` uses `z.string()` rather than `TimestampSchema` to match the
 * combat DTO's `CombatLogEntrySchema.createdAt` — both are ISO timestamps from
 * the server, parsed the same way on the client.
 */
export const PlaceBountyRequestSchema = z.object({
  targetUsername: z.string().min(1).max(30),
  amount: MoneySchema,
});
export type PlaceBountyRequest = z.infer<typeof PlaceBountyRequestSchema>;

export const PlaceBountyResponseSchema = z.object({
  bountyId: IdSchema,
  cash: MoneySchema,
});
export type PlaceBountyResponse = z.infer<typeof PlaceBountyResponseSchema>;

export const BountyRowSchema = z.object({
  id: IdSchema,
  amount: MoneySchema,
  createdAt: z.string(),
  targetId: IdSchema,
  targetUsername: z.string(),
  targetRank: z.string().nullable(),
  placerUsername: z.string(),
});
export type BountyRow = z.infer<typeof BountyRowSchema>;

export const BountyListResponseSchema = z.object({ bounties: z.array(BountyRowSchema) });
export type BountyListResponse = z.infer<typeof BountyListResponseSchema>;
