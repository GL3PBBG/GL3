import { z } from "zod";
import { noNulByte } from "../primitives.js";

/** `GET /api/challenge` — the human check a flagged player must answer. */
export const ChallengeQuestionSchema = z.object({ question: z.string() });
export type ChallengeQuestion = z.infer<typeof ChallengeQuestionSchema>;

export const ChallengeAnswerRequestSchema = z.object({
  answer: noNulByte(z.string().min(1).max(32)),
});
export type ChallengeAnswerRequest = z.infer<typeof ChallengeAnswerRequestSchema>;

export const ChallengeAnswerResponseSchema = z.object({ solved: z.literal(true) });
export type ChallengeAnswerResponse = z.infer<typeof ChallengeAnswerResponseSchema>;
