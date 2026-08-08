import { z } from "zod";
import { IdSchema, noNulByte } from "../primitives.js";

/** V2 capped usernames at 30 chars (SPEC §1.2 users.U_name); GL3 keeps that ceiling. */
export const RegisterRequestSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only"),
  email: z.string().email().optional(),
  password: z.string().min(8).max(200),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/**
 * Unlike `RegisterRequestSchema.username`, login's username isn't
 * regex-restricted — it just needs to match whatever was already
 * registered. That means it's not persisted, but it does reach Postgres
 * verbatim as an `eq(players.username, ...)` query parameter, and Postgres
 * rejects an embedded NUL byte in ANY text parameter — a value being
 * compared, not just one being written — with the same SQLSTATE 22021 this
 * repo's other noNulByte call sites guard against. `noNulByte` here closes
 * that, not because the value is stored, but because it reaches the
 * database at all.
 */
export const LoginRequestSchema = z.object({
  username: noNulByte(z.string().min(1).max(30)),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  token: z.string(),
  playerId: IdSchema,
  username: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const MeResponseSchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  cash: z.string(),
  bank: z.string(),
  bullets: z.string(),
  exp: z.string(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
