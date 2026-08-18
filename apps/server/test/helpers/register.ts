import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { verifyCodeFor } from "./verify.js";

export interface RegisteredPlayer { token: string; playerId: string; username: string }

/**
 * Registers a fresh player through the REAL flow — register, read the
 * verification code back out of Redis (the log mail driver only prints it),
 * then POST it to /api/auth/verify — rather than writing `emailVerifiedAt`
 * directly. Every test that just needs a playable player this way exercises
 * the same gate the feature itself proves, instead of quietly bypassing it.
 * `auth-verify.test.ts` is the one file that deliberately keeps raw
 * registration, because it's testing the unverified state itself.
 *
 * Takes `{ app, redis }` structurally so either `bootTestServer()`'s return
 * value or a hand-assembled `{ app, redis }` pair (files that call
 * `buildApp` directly and open their own Redis client) both work unchanged.
 */
export async function registerVerifiedPlayer(
  server: { app: FastifyInstance; redis: Redis },
  overrides?: { username?: string; email?: string; password?: string; remoteAddress?: string },
): Promise<RegisteredPlayer> {
  const unique = randomUUID().slice(0, 8);
  const username = overrides?.username ?? `p_${unique}`;
  const email = overrides?.email ?? `${username}_${unique}@example.test`;
  const password = overrides?.password ?? "password123";

  const register = await server.app.inject({
    method: "POST", url: "/api/auth/register",
    remoteAddress: overrides?.remoteAddress,
    payload: { username, email, password },
  });
  if (register.statusCode !== 201) {
    throw new Error(`registerVerifiedPlayer: register failed ${register.statusCode}: ${register.body}`);
  }
  const { token, playerId } = register.json() as { token: string; playerId: string };

  const code = await verifyCodeFor(server.redis, playerId);
  const verify = await server.app.inject({
    method: "POST", url: "/api/auth/verify",
    remoteAddress: overrides?.remoteAddress,
    payload: { code },
  });
  if (verify.statusCode !== 200) {
    throw new Error(`registerVerifiedPlayer: verify failed ${verify.statusCode}: ${verify.body}`);
  }

  return { token, playerId, username };
}
