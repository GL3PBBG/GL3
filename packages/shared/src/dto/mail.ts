import { z } from "zod";
import { IdSchema, TimestampSchema } from "../primitives.js";

export const SendMailRequestSchema = z.object({
  recipientUsername: z.string().min(3).max(30),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  /** Reply within an existing thread; omit to start a new one. */
  threadId: IdSchema.optional(),
});
export type SendMailRequest = z.infer<typeof SendMailRequestSchema>;

export const MailDtoSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  senderId: IdSchema.nullable(),
  senderName: z.string().nullable(),
  recipientId: IdSchema,
  subject: z.string(),
  body: z.string(),
  readAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type MailDto = z.infer<typeof MailDtoSchema>;

export const MailListResponseSchema = z.object({ mail: z.array(MailDtoSchema) });
export type MailListResponse = z.infer<typeof MailListResponseSchema>;
