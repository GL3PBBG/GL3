import { z } from "zod";
import { IdSchema, TimestampSchema } from "../primitives.js";

export const NotificationDtoSchema = z.object({
  id: IdSchema,
  body: z.string(),
  readAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type NotificationDto = z.infer<typeof NotificationDtoSchema>;

export const NotificationListResponseSchema = z.object({ notifications: z.array(NotificationDtoSchema) });
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;
