import { z } from "zod";
import { IdSchema, MoneySchema, TimestampSchema } from "../primitives.js";

/**
 * avatarUrl is attacker-controlled, persisted server-side, and served to
 * every visitor of a public profile page. `z.string().url()` alone accepts
 * any scheme the `URL` constructor parses — including `javascript:` and
 * `data:` — which is a stored-XSS / phishing vector the moment a client
 * renders it as a link `href` (or an `<img src>`, for the phishing/exfil
 * case even where script execution is refused). Constraining the scheme
 * here, at the schema, makes the restriction hold for every future caller
 * instead of depending on each client to sanitise.
 */
const ALLOWED_AVATAR_PROTOCOLS = new Set(["http:", "https:"]);

export const UpdateProfileRequestSchema = z.object({
  bio: z.string().max(1000).optional(),
  avatarUrl: z
    .string()
    .url()
    .max(500)
    .refine((value) => ALLOWED_AVATAR_PROTOCOLS.has(new URL(value).protocol), {
      message: "avatarUrl must be an http(s) URL",
    })
    .optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export const ProfileDtoSchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  gangId: IdSchema.nullable(),
  gangName: z.string().nullable(),
  exp: MoneySchema,
  rankName: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type ProfileDto = z.infer<typeof ProfileDtoSchema>;
