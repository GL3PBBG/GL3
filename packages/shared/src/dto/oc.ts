import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

/**
 * Mirrors GET /api/oc and the mutation routes in packages/plugins/oc.
 *
 * `buyIn` uses `MoneySchema` (decimal string) to match the server's
 * `bigint.toString()` serialisation. All money fields cross the wire as
 * decimal strings — no floating point.
 */
export const OcMemberSchema = z.object({
  playerId: IdSchema,
  role: z.string(),
  state: z.enum(["invited", "accepted"]),
  username: z.string(),
});
export type OcMember = z.infer<typeof OcMemberSchema>;

export const OcHeistSchema = z.object({
  id: IdSchema,
  status: z.enum(["open", "executing", "done", "failed", "cancelled"]),
  buyIn: MoneySchema,
  locationId: IdSchema,
  leaderId: IdSchema,
  members: z.array(OcMemberSchema),
});
export type OcHeist = z.infer<typeof OcHeistSchema>;

export const OcInviteSchema = z.object({
  heistId: IdSchema,
  role: z.string(),
  buyIn: MoneySchema,
  leaderId: IdSchema,
  leaderUsername: z.string(),
});
export type OcInvite = z.infer<typeof OcInviteSchema>;

export const OcStateResponseSchema = z.object({
  heist: OcHeistSchema.nullable(),
  invites: z.array(OcInviteSchema),
});
export type OcStateResponse = z.infer<typeof OcStateResponseSchema>;

/** Returned by accept, leave and cancel — mutations that move cash. */
export const OcCashResponseSchema = z.object({ cash: MoneySchema });
export type OcCashResponse = z.infer<typeof OcCashResponseSchema>;

/** Returned by create — the new heist id plus updated cash. */
export const OcCreateResponseSchema = z.object({
  heistId: IdSchema,
  cash: MoneySchema,
});
export type OcCreateResponse = z.infer<typeof OcCreateResponseSchema>;
