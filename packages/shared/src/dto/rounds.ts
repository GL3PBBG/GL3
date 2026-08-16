import { z } from "zod";
import { IdSchema, TimestampSchema } from "../primitives.js";
import { LeaderboardEntrySchema, LeaderboardKindSchema } from "./leaderboard.js";

export const RoundDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  startsAt: TimestampSchema.nullable(),
  endsAt: TimestampSchema.nullable(),
  /** null when endsAt is null (an open-ended round never counts down). */
  secondsRemaining: z.number().int().nonnegative().nullable(),
  finalizedAt: TimestampSchema.nullable(),
});
export type RoundDto = z.infer<typeof RoundDtoSchema>;

export const RoundListResponseSchema = z.object({
  active: RoundDtoSchema.nullable(),
  finished: z.array(RoundDtoSchema),
});
export type RoundListResponse = z.infer<typeof RoundListResponseSchema>;

export const RoundStandingsResponseSchema = z.object({
  roundId: IdSchema,
  roundName: z.string(),
  kind: LeaderboardKindSchema,
  /** true once finalized_at is set: the board is frozen and will never move again. */
  finalized: z.boolean(),
  entries: z.array(LeaderboardEntrySchema),
});
export type RoundStandingsResponse = z.infer<typeof RoundStandingsResponseSchema>;
