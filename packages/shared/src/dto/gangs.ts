import { z } from "zod";
import { IdSchema, MoneySchema, TimestampSchema } from "../primitives.js";

export const CreateGangRequestSchema = z.object({
  name: z.string().min(3).max(50).regex(/^[A-Za-z0-9 _'-]+$/, "letters, digits, spaces, _ - ' only"),
  description: z.string().max(500).optional(),
  info: z.string().max(2000).optional(),
});
export type CreateGangRequest = z.infer<typeof CreateGangRequestSchema>;

export const GangDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  info: z.string(),
  bank: MoneySchema,
  cash: MoneySchema,
  level: z.number().int(),
  bossPlayerId: IdSchema,
  underbossPlayerId: IdSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
});
export type GangDto = z.infer<typeof GangDtoSchema>;

export const GangLogDtoSchema = z.object({
  id: IdSchema,
  playerId: IdSchema.nullable(),
  message: z.string(),
  createdAt: TimestampSchema,
});
export type GangLogDto = z.infer<typeof GangLogDtoSchema>;

export const GangLogListResponseSchema = z.object({ logs: z.array(GangLogDtoSchema) });

export const InvitePlayerRequestSchema = z.object({ username: z.string().min(3).max(30) });
export type InvitePlayerRequest = z.infer<typeof InvitePlayerRequestSchema>;

export const GrantPermissionRequestSchema = z.object({
  playerId: IdSchema,
  permission: z.enum(["invite", "kick", "bank.withdraw", "edit_info", "grant_permissions"]),
});
export type GrantPermissionRequest = z.infer<typeof GrantPermissionRequestSchema>;

export const GangBankTransferRequestSchema = z.object({
  amount: MoneySchema.refine((v) => BigInt(v) > 0n, "amount must be positive"),
});
export type GangBankTransferRequest = z.infer<typeof GangBankTransferRequestSchema>;
