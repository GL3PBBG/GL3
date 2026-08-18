import { z } from "zod";
import { IdSchema, noNulByte } from "../primitives.js";

export const ForumSchema = z.object({
  id: IdSchema, name: z.string(), sort: z.number().int(),
  topicCount: z.number().int(),
});
export const ForumListResponseSchema = z.object({ forums: z.array(ForumSchema) });
export type ForumListResponse = z.infer<typeof ForumListResponseSchema>;

export const ForumTopicSchema = z.object({
  id: IdSchema,
  subject: z.string(),
  authorId: IdSchema.nullable(),
  authorName: z.string().nullable(),
  status: z.enum(["open", "locked"]),
  type: z.enum(["normal", "sticky"]),
  createdAt: z.string(),
  lastPostAt: z.string(),
  postCount: z.number().int(),
});
export const ForumTopicListResponseSchema = z.object({
  forumId: IdSchema, forumName: z.string(),
  topics: z.array(ForumTopicSchema),
  page: z.number().int(), pageCount: z.number().int(),
});
export type ForumTopicListResponse = z.infer<typeof ForumTopicListResponseSchema>;

export const ForumPostSchema = z.object({
  id: IdSchema,
  authorId: IdSchema.nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export const ForumTopicViewResponseSchema = z.object({
  topic: ForumTopicSchema,
  posts: z.array(ForumPostSchema),
  page: z.number().int(), pageCount: z.number().int(),
});
export type ForumTopicViewResponse = z.infer<typeof ForumTopicViewResponseSchema>;

/** V2 minimums: subject ≥ 6, bodies ≥ 6. */
export const CreateTopicRequestSchema = z.object({
  subject: noNulByte(z.string().min(6).max(120)),
  body: noNulByte(z.string().min(6).max(10_000)),
});
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;

export const CreatePostRequestSchema = z.object({
  body: noNulByte(z.string().min(6).max(10_000)),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;
