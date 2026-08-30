import type { PlayerSnapshot, PluginManifest } from "@gl3/plugin-sdk";
import { isPluginError, hasPermission } from "@gl3/plugin-sdk";
import { dumpRecentQueries, type Db } from "../db/client.js";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { players, playerStats, roleModuleAccess } from "../db/schema/index.js";
import { settleHospital } from "../game/hospital/status.js";
import { createOutboxDelivery } from "../bus/outbox.js";
import { releaseIfExpired } from "../game/jail/status.js";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";
import { collectAssetSlots } from "./asset-slots.js";
import { collectAttributePools } from "./attribute-pools.js";
import { collectExpRouters } from "./exp-routers.js";
import { collectPropertyTypes } from "./property-types.js";

export function registerPluginRoutes(
  app: FastifyInstance,
  manifests: readonly PluginManifest[],
  deps: PluginCtxDeps,
): void {
  for (const manifest of manifests) {
    for (const pluginRoute of manifest.routes) {
      const preHandler = pluginRoute.auth === "public" ? [] : [app.requireAuth];

      app.route({
        method: pluginRoute.method,
        url: pluginRoute.path,
        preHandler,
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          const playerId = request.playerId;

          if (pluginRoute.auth === "admin") {
            // requireAuth has run; playerId is set. Grants resolve fresh per
            // request — no cache, so a revoked role loses access immediately.
            if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
            const grants = await loadGrants(deps.db, playerId);
            if (!hasPermission(grants, manifest.id)) {
              return reply.code(403).send({ error: "forbidden" });
            }
          }

          if (!pluginRoute.accessInJail && playerId !== undefined) {
            // Same call, same order, same response as crimes/bullets/travel —
            // GET-side release still happens here, so a sentence that expired
            // ends on the next action rather than on a poll.
            const jail = await releaseIfExpired(deps.db, createOutboxDelivery(deps.db, { redis: deps.redis }), playerId);
            if (jail.jailed) {
              // Core's jail-gated routes set this alongside the body
              // (game/bullets/routes.ts:19). A ported module must not lose it.
              reply.header("retry-after", String(jail.remainingSeconds));
              return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
            }
          }

          if (!pluginRoute.accessInHospital && playerId !== undefined) {
            // settleHospital needs a transaction (it may UPDATE), unlike
            // jail's releaseIfExpired which takes `db`. Restoring health on
            // expiry is a write, and it must not be observed half-applied by
            // the handler that runs immediately after.
            const hospital = await deps.db.transaction((tx) => settleHospital(tx, playerId));
            if (hospital.hospitalised) {
              reply.header("retry-after", String(hospital.remainingSeconds));
              return reply.code(423).send({
                error: "hospitalised",
                remainingSeconds: hospital.remainingSeconds,
              });
            }
          }

          // Zod before the handler: an unvalidated UUID reaching Postgres 500s
          // instead of returning a clean 400.
          const params = pluginRoute.params.safeParse(request.params);
          if (!params.success) return reply.code(400).send({ error: "invalid_request" });
          const body = pluginRoute.body.safeParse(request.body);
          if (!body.success) return reply.code(400).send({ error: "invalid_request" });
          const query = pluginRoute.query.safeParse(request.query);
          if (!query.success) return reply.code(400).send({ error: "invalid_request" });

          const player = playerId === undefined ? null : await loadSnapshot(deps, playerId);
          const ctx = createPluginCtx(deps, {
            pluginId: manifest.id,
            player,
            job: null,
            filters: collectFilters(manifests),
            propertyTypes: collectPropertyTypes(manifests),
            attributePools: collectAttributePools(manifests),
            expRouter: collectExpRouters(manifests),
            installedPluginIds: new Set(manifests.map((m) => m.id)),
            assetSlots: collectAssetSlots(manifests),
          });

          try {
            const result = await pluginRoute.handler(ctx, { params: params.data, body: body.data, query: query.data });
            return result.body === undefined
              ? await reply.code(result.status).send()
              : await reply.code(result.status).send(result.body);
          } catch (error) {
            // `isPluginError`, NOT `instanceof`: a plugin loaded through
            // `PLUGIN_PACKAGES` resolves its own copy of @gl3/plugin-sdk out of
            // the operator's plugin directory, so its PluginError is a
            // different class object than ours and `instanceof` is false. Every
            // deliberate 400/409/423 from such a plugin would fall through to
            // the 500 below. See the brand comment in the SDK's errors.ts.
            if (isPluginError(error)) {
              for (const [name, value] of Object.entries(error.headers)) {
                reply.header(name, value);
              }
              return reply.code(error.status).send({ error: error.code, ...error.extra });
            }
            // Drizzle wraps a driver error as `DrizzleQueryError` and puts the
            // SQL in `message` — but the SQLSTATE, the detail and the table
            // name all live on `cause`, which nothing was reading. A 500 then
            // reaches the client (and the test log) as a bare "Failed query:
            // select ... for update" with NO code, which is unactionable:
            // 40P01 (deadlock), 55P03 (lock timeout) and a dropped connection
            // are indistinguishable from each other in that string. Two
            // load-dependent failures on this repo's lock-order tests have now
            // been diagnosed blind for exactly this reason. Logging the cause
            // does not change the response.
            //
            // console, NOT request.log: app.ts builds Fastify with
            // `logger: config.nodeEnv !== "test"`, so a request.log line is a
            // no-op in the ONE environment where those flakes occur and the
            // datum kept being dropped (three occurrences before this was
            // noticed). ctx.log already logs plugins via console, and vitest
            // captures console output — see plugin-routes.test.ts's
            // "logs a driver error's SQLSTATE cause" for the pin.
            const cause: unknown = error instanceof Error ? error.cause : undefined;
            if (cause !== null && typeof cause === "object") {
              const pg: Record<string, unknown> = { ...cause };
              console.error(
                {
                  plugin: manifest.id,
                  pgCode: pg["code"],
                  pgDetail: pg["detail"],
                  pgTable: pg["table_name"],
                  pgMessage: pg["message"],
                },
                "plugin route failed with a driver error",
              );
              // A deadlock report names only the two BLOCKED statements; the
              // locks that formed the cycle came from earlier statements in
              // each transaction. Dump this process's per-connection recent-
              // statement rings so the next natural 40P01 (the casino ABBA
              // flake survived a ~45k-race repro hunt unfired) carries its
              // own post-mortem instead of another blind chase.
              if (pg["code"] === "40P01") {
                // JSON, not console.error's object inspection: Node truncates
                // arrays at 100 entries ("... 20 more items"), and the 2026-08-30
                // capture lost the exact statement that closed the cycle to it.
                console.error(
                  JSON.stringify(dumpRecentQueries()),
                  "recent statements per pool connection at deadlock",
                );
              }
            }
            throw error;
          }
        },
      });
    }
  }
}

/** Exported so `core-filters.ts`'s `buildCoreFilters` can reuse this exact
 *  collection rather than re-deriving it — the same bound-subscription shape
 *  every plugin ctx factory needs. */
export function collectFilters(manifests: readonly PluginManifest[]) {
  return manifests.flatMap((m) => m.filters.map((subscription) => ({ ownerId: m.id, subscription })));
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

/** Module keys granted by the player's role; [] when roleless. */
export async function loadGrants(db: Db, playerId: string): Promise<string[]> {
  const rows = await db
    .select({ moduleKey: roleModuleAccess.moduleKey })
    .from(players)
    .innerJoin(roleModuleAccess, eq(roleModuleAccess.roleId, players.roleId))
    .where(eq(players.id, playerId));
  return rows.map((r) => r.moduleKey);
}
