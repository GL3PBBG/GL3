import type { PlayerSnapshot, PluginManifest } from "@gl3/plugin-sdk";
import { PluginError } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { players, playerStats } from "../db/schema/index.js";
import { releaseIfExpired } from "../game/jail/status.js";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";

export function registerPluginRoutes(
  app: FastifyInstance,
  manifests: readonly PluginManifest[],
  deps: PluginCtxDeps,
): void {
  for (const manifest of manifests) {
    for (const pluginRoute of manifest.routes) {
      const preHandler = pluginRoute.auth === "player" ? [app.requireAuth] : [];

      app.route({
        method: pluginRoute.method,
        url: pluginRoute.path,
        preHandler,
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          const playerId = request.playerId;

          if (!pluginRoute.accessInJail && playerId !== undefined) {
            // Same call, same order, same response as crimes/bullets/travel —
            // GET-side release still happens here, so a sentence that expired
            // ends on the next action rather than on a poll.
            const jail = await releaseIfExpired(deps.db, deps.redis, playerId);
            if (jail.jailed) {
              // Core's jail-gated routes set this alongside the body
              // (game/bullets/routes.ts:19). A ported module must not lose it.
              reply.header("retry-after", String(jail.remainingSeconds));
              return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
            }
          }

          // Zod before the handler: an unvalidated UUID reaching Postgres 500s
          // instead of returning a clean 400.
          const params = pluginRoute.params.safeParse(request.params);
          if (!params.success) return reply.code(400).send({ error: "invalid_request" });
          const body = pluginRoute.body.safeParse(request.body);
          if (!body.success) return reply.code(400).send({ error: "invalid_request" });

          const player = playerId === undefined ? null : await loadSnapshot(deps, playerId);
          const ctx = createPluginCtx(deps, {
            pluginId: manifest.id,
            player,
            job: null,
            filters: collectFilters(manifests),
          });

          try {
            const result = await pluginRoute.handler(ctx, { params: params.data, body: body.data });
            return result.body === undefined
              ? await reply.code(result.status).send()
              : await reply.code(result.status).send(result.body);
          } catch (error) {
            if (error instanceof PluginError) {
              return reply.code(error.status).send({ error: error.code, ...error.extra });
            }
            throw error;
          }
        },
      });
    }
  }
}

function collectFilters(manifests: readonly PluginManifest[]) {
  return manifests.flatMap((m) => m.filters);
}

/**
 * Reads `username` from `players`; `cash`, `bank`, `jailedUntil`, `gangId`
 * from `player_stats` (not `players` — that table has no balance columns).
 * `level` is set to 0 as a placeholder: there is no canonical player level in
 * the schema, only `exp` (bigint) and `rankId`. Nothing consumes `.level`
 * today; 0 until a port needs it.
 */
export async function loadSnapshot(deps: PluginCtxDeps, playerId: string): Promise<PlayerSnapshot | null> {
  const [row] = await deps.db
    .select({
      id: players.id,
      username: players.username,
      cash: playerStats.cash,
      bank: playerStats.bank,
      jailedUntil: playerStats.jailedUntil,
      gangId: playerStats.gangId,
    })
    .from(players)
    .innerJoin(playerStats, eq(playerStats.playerId, players.id))
    .where(eq(players.id, playerId));
  if (row === undefined) return null;
  return {
    id: row.id,
    username: row.username,
    cash: row.cash,
    bank: row.bank,
    level: 0,
    jailed: row.jailedUntil !== null && row.jailedUntil.getTime() > Date.now(),
    gangId: row.gangId,
  };
}
