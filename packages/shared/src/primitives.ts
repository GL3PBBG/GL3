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

/** Who is allowed to receive an event. The WS gateway routes on this alone. */
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("player"), playerId: IdSchema }),
  z.object({ kind: z.literal("gang"), gangId: IdSchema }),
]);
export type Audience = z.infer<typeof AudienceSchema>;
