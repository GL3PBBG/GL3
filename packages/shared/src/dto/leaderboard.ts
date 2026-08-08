import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

export const LeaderboardKindSchema = z.enum(["cash", "bank", "exp"]);
export type LeaderboardKind = z.infer<typeof LeaderboardKindSchema>;

export const LeaderboardEntrySchema = z.object({
  playerId: IdSchema, username: z.string(), score: MoneySchema, rank: z.number().int().positive(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardResponseSchema = z.object({ kind: LeaderboardKindSchema, entries: z.array(LeaderboardEntrySchema) });
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
