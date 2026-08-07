import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { LoginRequestSchema, RegisterRequestSchema } from "@gl3/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { players, playerStats } from "../db/schema/index.js";
import { hashPassword, verifyLegacyPassword, verifyPassword } from "./password.js";
import { tokenBucket } from "./rate-limit.js";
import { createSession, destroySession, readSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest { playerId?: string }
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/**
 * PostgreSQL SQLSTATE 23505 = unique_violation. drizzle-orm wraps the raw
 * driver error in its own `DrizzleQueryError`, with the real `PostgresError`
 * attached as `.cause` — so the unique-violation check has to look one level
 * down the `Error.cause` chain, not just at the thrown error itself.
 */
function uniqueViolation(err: unknown): postgres.PostgresError | null {
  const candidate = err instanceof postgres.PostgresError ? err
    : err instanceof Error && err.cause instanceof postgres.PostgresError ? err.cause
    : null;
  return candidate?.code === "23505" ? candidate : null;
}

export function registerAuthRoutes(app: FastifyInstance, config: Config, db: Db, redis: Redis): void {
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearer(request);
    const playerId = token ? await readSession(redis, token) : null;
    if (!playerId) { await reply.code(401).send({ error: "unauthorized" }); return; }
    request.playerId = playerId;
  };
  app.decorate("requireAuth", requireAuth);

  app.post("/api/auth/register", {
    preHandler: tokenBucket(redis, { name: "register", limit: 5, windowSeconds: 3600 }),
  }, async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    const existing = await db.select({ id: players.id }).from(players).where(eq(players.username, parsed.data.username));
    if (existing.length > 0) return reply.code(409).send({ error: "username_taken" });

    const playerId = uuidv7();
    const passwordHash = await hashPassword(parsed.data.password);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(players).values({
          id: playerId,
          username: parsed.data.username,
          email: parsed.data.email ?? null,
          passwordHash,
        });
        await tx.insert(playerStats).values({ playerId });
      });
    } catch (err) {
      // Unique index is the real arbiter; the pre-check above only saves a hash round.
      // Only a genuine unique-constraint violation is a client error (409) — anything
      // else (connection loss, constraint we don't recognise, etc.) is a real failure
      // and must surface as one, not be misreported as "username taken".
      const violation = uniqueViolation(err);
      if (violation?.constraint_name === "players_username_unique") {
        return reply.code(409).send({ error: "username_taken" });
      }
      if (violation?.constraint_name === "players_email_unique") {
        return reply.code(409).send({ error: "email_taken" });
      }
      throw err;
    }

    const token = await createSession(redis, playerId, config.sessionTtlSeconds);
    return reply.code(201).send({ token, playerId, username: parsed.data.username });
  });

  app.post("/api/auth/login", {
    preHandler: tokenBucket(redis, { name: "login", limit: 10, windowSeconds: 900 }),
  }, async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [player] = await db.select().from(players).where(eq(players.username, parsed.data.username));
    if (!player) return reply.code(401).send({ error: "invalid_credentials" });

    let authenticated = false;

    if (player.passwordHash) {
      authenticated = await verifyPassword(player.passwordHash, parsed.data.password);
    } else if (player.legacyPasswordSha256 !== null && player.legacyV2Id !== null) {
      // SPEC §4.3: verify against the V2 formula, then rehash with argon2id and null the legacy column.
      authenticated = verifyLegacyPassword(player.legacyPasswordSha256, player.legacyV2Id, parsed.data.password);
      if (authenticated) {
        const upgraded = await hashPassword(parsed.data.password);
        await db.update(players)
          .set({ passwordHash: upgraded, legacyPasswordSha256: null })
          .where(eq(players.id, player.id));
        request.log.info({ event: "auth.legacy_upgraded", playerId: player.id });
      }
    }

    if (!authenticated) return reply.code(401).send({ error: "invalid_credentials" });

    const token = await createSession(redis, player.id, config.sessionTtlSeconds);
    return reply.code(200).send({ token, playerId: player.id, username: player.username });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = bearer(request);
    if (token) await destroySession(redis, token);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const [row] = await db.select({
      username: players.username,
      cash: playerStats.cash, bank: playerStats.bank,
      bullets: playerStats.bullets, exp: playerStats.exp,
    }).from(players)
      .innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .where(eq(players.id, playerId));

    if (!row) return reply.code(404).send({ error: "player_not_found" });

    return reply.send({
      playerId, username: row.username,
      cash: row.cash.toString(), bank: row.bank.toString(),
      bullets: row.bullets.toString(), exp: row.exp.toString(),
    });
  });
}
