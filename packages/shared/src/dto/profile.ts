import { z } from "zod";
import { IdSchema, MoneySchema, noNulByte, TimestampSchema } from "../primitives.js";
import { ProfileExtraSchema } from "./extensions.js";

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
 * Validates AND normalizes in one pass, and — critically — the value that
 * gets STORED is the normalized value, not the client's raw string. Round
 * 1 validated `new URL(value).protocol` but persisted `value` unmodified,
 * so a leading space, a trailing newline, or a schemeless `https:evil.com`
 * (which a browser resolves to `https://evil.com`) all passed the scheme
 * check and then persisted exactly as submitted — meaning any downstream
 * re-parse (a CSP allowlist, a thumbnail proxy) could legitimately
 * disagree with this handler about what URL it actually is. `new
 * URL(value).toString()` is the canonical form; storing that instead
 * closes that gap. It also happens to close the NUL-byte-in-the-path case
 * on its own (the WHATWG URL parser percent-encodes it to a literal
 * "%00"), but `noNulByte` below still runs first — the persisted-text
 * guard should not depend on incidental behaviour of an unrelated parser.
 *
 * Also rejects non-empty userinfo (`url.username`/`url.password`).
 * `https://paypal.com@evil.com/logo.png` is the classic phishing shape: as
 * an `<img src>` it triggers a credentialed cross-origin fetch to
 * evil.com; as an `href` it reads as one host and navigates to another.
 */
const avatarUrlSchema = noNulByte(z.string().max(500)).transform((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "avatarUrl must be a valid URL" });
    return z.NEVER;
  }
  if (!ALLOWED_AVATAR_PROTOCOLS.has(parsed.protocol)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "avatarUrl must be an http(s) URL" });
    return z.NEVER;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "avatarUrl must not contain embedded credentials" });
    return z.NEVER;
  }
  return parsed.toString();
});

export const UpdateProfileRequestSchema = z
  .object({
    bio: noNulByte(z.string().max(1000)).optional(),
    avatarUrl: avatarUrlSchema.optional(),
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
  /**
   * The wealth BRACKET, never the figure. `cash`/`bank` are read to compute
   * it and are never returned. Null when the player is below the lowest
   * threshold, or when `money_ranks` is empty.
   */
  moneyRankLabel: z.string().nullable(),
  /** Lifetime count of the player's own weapon backfiring. */
  backfire: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  lastSeenAt: z.string().nullable().optional(),
  /**
   * Plugin-contributed fragments from the `core.profileView` filter point.
   * Optional rather than a bare array so a server that predates the
   * extension surface still parses.
   */
  extras: z.array(ProfileExtraSchema).optional(),
});
export type ProfileDto = z.infer<typeof ProfileDtoSchema>;
