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

/**
 * `.url()` marks a failing ZodString check *dirty*, not *aborted* — the
 * chained `.refine()` still runs against the original (unparseable) input
 * even after `.url()` has already failed it. `new URL(value)` therefore
 * must be assumed reachable with ANY string, so this predicate must never
 * throw: a `try/catch` makes it total, returning `false` instead of
 * propagating a `TypeError` out of `safeParse` (which is documented to
 * never throw) and crashing the request with an uncaught 500.
 */
function isHttpUrl(value: string): boolean {
  try {
    return ALLOWED_AVATAR_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export const UpdateProfileRequestSchema = z
  .object({
    bio: z.string().max(1000).optional(),
    avatarUrl: z.string().max(500).refine(isHttpUrl, { message: "avatarUrl must be an http(s) URL" }).optional(),
  })
  // Both fields are optional, so `{}` parses successfully; that in turn
  // leaves the route's conditional spread with nothing to set, and
  // drizzle's `mapUpdateSet` throws `Error("No values to set")` on an empty
  // update — uncaught, another 500 for what is really a client error. This
  // repo's convention is to reject a body that specifies no valid
  // operation with a clean 400 at the boundary, not let it reach the
  // persistence layer.
  .refine((data) => data.bio !== undefined || data.avatarUrl !== undefined, {
    message: "at least one of bio or avatarUrl is required",
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
