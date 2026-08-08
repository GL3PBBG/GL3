import { z } from "zod";
import { IdSchema, TimestampSchema } from "../primitives.js";

export const PostNewsRequestSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
});
export type PostNewsRequest = z.infer<typeof PostNewsRequestSchema>;

export const NewsDtoSchema = z.object({
  id: IdSchema,
  authorId: IdSchema.nullable(),
  authorName: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  createdAt: TimestampSchema,
});
export type NewsDto = z.infer<typeof NewsDtoSchema>;

export const NewsListResponseSchema = z.object({ news: z.array(NewsDtoSchema) });
export type NewsListResponse = z.infer<typeof NewsListResponseSchema>;
