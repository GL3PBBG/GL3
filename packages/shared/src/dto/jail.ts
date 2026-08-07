import { z } from "zod";
import { TimestampSchema } from "../primitives.js";

export const JailStatusSchema = z.object({
  jailed: z.boolean(),
  until: TimestampSchema.nullable(),
  remainingSeconds: z.number().int().nonnegative(),
});
export type JailStatus = z.infer<typeof JailStatusSchema>;
