import { z } from "zod";

/** UUIDv7 is still a uuid by format; zod's uuid check accepts it. */
export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

/**
 * A Postgres `bigint` serialised for transport. JSON has no bigint and the
 * economy forbids floating point, so money crosses process boundaries as a
 * decimal string and is converted with `BigInt(...)` at the edge.
 */
export const MoneySchema = z.string().regex(/^-?\d+$/, "must be an integer string");
export type Money = z.infer<typeof MoneySchema>;

export const TimestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * Postgres `text` rejects an embedded NUL byte outright (SQLSTATE 22021,
 * "invalid byte sequence for encoding UTF8") — `z.string()` alone has no
 * opinion on it. A NUL anywhere in an inbound field that gets persisted
 * verbatim is a legal, well-formed JSON string that passes zod, reaches
 * drizzle, and comes back from Postgres as an uncaught `PostgresError`: a
 * 500 with the raw database error in the response body, for what should be
 * a clean 400.
 *
 * Apply this to every INBOUND request field that is persisted to a
 * Postgres `text` column, so a new field only has to remember to reach for
 * this instead of bare `z.string()`. Response DTOs don't need it — they
 * only ever echo values Postgres already accepted.
 *
 * Deliberately NUL-only, not "no C0 control characters": tab, newline and
 * carriage return are C0 controls too, and are legitimate content in every
 * field this guards (multi-line bio, mail body, gang info, news body). A
 * blanket C0 ban would silently break that. NUL is the one control
 * character that actually corrupts Postgres storage; anything else is a
 * rendering concern for whichever client displays the text, not a
 * validation concern here.
 */
export function noNulByte<T extends z.ZodString>(schema: T): z.ZodEffects<T, string, string> {
  return schema.refine((value) => !value.includes("\u0000"), { message: "must not contain a NUL byte" });
}

/** Who is allowed to receive an event. The WS gateway routes on this alone. */
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("player"), playerId: IdSchema }),
  z.object({ kind: z.literal("gang"), gangId: IdSchema }),
]);
export type Audience = z.infer<typeof AudienceSchema>;
