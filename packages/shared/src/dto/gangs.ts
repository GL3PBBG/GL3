import { z } from "zod";
import { IdSchema, MoneySchema, noNulByte, TimestampSchema } from "../primitives.js";

export const CreateGangRequestSchema = z.object({
  // The regex allowlist already excludes NUL (not in the character class),
  // so `name` doesn't need noNulByte on top of it.
  name: z.string().min(3).max(50).regex(/^[A-Za-z0-9 _'-]+$/, "letters, digits, spaces, _ - ' only"),
  description: noNulByte(z.string().max(500)).optional(),
  info: noNulByte(z.string().max(2000)).optional(),
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
  /** Absent when no crest is bound — see `InventoryItemSchema.imageUrl`. */
  imageUrl: z.string().optional(),
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
export type GangLogListResponse = z.infer<typeof GangLogListResponseSchema>;

// The server's own GANG_PERMISSIONS tuple (game/gangs/permissions.ts) is the
// list this mirrors; they must stay in step, and gang-members.test.ts asserts
// they do rather than leaving it to a reader.
export const GangPermissionSchema = z.enum(["invite", "kick", "bank.withdraw", "edit_info", "grant_permissions"]);
export type GangPermission = z.infer<typeof GangPermissionSchema>;

// Role is derived, never stored: gangs.boss_player_id / underboss_player_id
// against a plain gang_members row. A client cannot compute it from GangDto
// alone for anyone but the boss and underboss, so the server sends it.
export const GangMemberDtoSchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  role: z.enum(["boss", "underboss", "member"]),
  permissions: z.array(GangPermissionSchema),
  joinedAt: TimestampSchema,
});
export type GangMemberDto = z.infer<typeof GangMemberDtoSchema>;

export const GangMemberListResponseSchema = z.object({ members: z.array(GangMemberDtoSchema) });
export type GangMemberListResponse = z.infer<typeof GangMemberListResponseSchema>;

// An invite reaches the invitee as a notification whose body is prose with no
// id in it, so this list is the only way a client can name an invite to
// accept or decline it.
export const GangInviteDtoSchema = z.object({
  id: IdSchema,
  gangId: IdSchema,
  gangName: z.string(),
  invitedByPlayerId: IdSchema,
  invitedByUsername: z.string(),
  createdAt: TimestampSchema,
});
export type GangInviteDto = z.infer<typeof GangInviteDtoSchema>;

export const GangInviteListResponseSchema = z.object({ invites: z.array(GangInviteDtoSchema) });
export type GangInviteListResponse = z.infer<typeof GangInviteListResponseSchema>;

export const GangBankTransferRequestSchema = z.object({
  amount: MoneySchema.refine((v) => BigInt(v) > 0n, "amount must be positive"),
});
export type GangBankTransferRequest = z.infer<typeof GangBankTransferRequestSchema>;

// The gang bank answers with the gang's new balance only — the mover's own
// cash is not in it, so a client that shows both has to refresh the HUD
// separately rather than reading it from here.
export const GangBankResponseSchema = z.object({ bank: MoneySchema });
export type GangBankResponse = z.infer<typeof GangBankResponseSchema>;
