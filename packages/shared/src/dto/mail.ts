import { z } from "zod";
import { IdSchema, noNulByte, TimestampSchema } from "../primitives.js";

export const SendMailRequestSchema = z.object({
  // Not persisted, but reaches Postgres as an `eq(players.username, ...)`
  // lookup parameter — Postgres rejects an embedded NUL in any text
  // parameter, not just one being written, so this needs noNulByte too.
  recipientUsername: noNulByte(z.string().min(3).max(30)),
  subject: noNulByte(z.string().min(1).max(200)),
  body: noNulByte(z.string().min(1).max(5000)),
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
