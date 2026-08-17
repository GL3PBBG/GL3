import type { PluginManifest, RouteResult } from "@gl3/plugin-sdk";
import type { Redis } from "ioredis";
import type { Db } from "../../src/db/client.js";
import { createPluginCtx } from "../../src/plugins/ctx.js";
import { loadSnapshot } from "../../src/plugins/routes.js";

export interface CallPluginRouteOptions {
  db: Db;
  redis: Redis;
  /**
   * Required, never defaulted: an omitted prefix silently means the
   * production `leaderboard:*` keys, which every concurrent test file and
   * agent shares. Same reasoning as `PluginCtxDeps.leaderboardPrefix`.
   */
  leaderboardPrefix: string;
  playerId: string;
  body?: unknown;
  params?: unknown;
  /**
   * Defaults to `{}` — a route reading a setting must be given one here, the
   * same way `bootTestServer` gets them from the `settings` table.
   */
  settings?: Record<string, string>;
}

/**
 * Drives one plugin route in-process: real Postgres, real Redis, the real
 * ctx, the route's own zod schemas and the real handler.
 *
 * This is NOT the HTTP contract and must not be mistaken for it. It runs no
 * jail gate, no auth, and no `PluginError` → status mapping — a `PluginError`
 * propagates to the caller, so a test asserts on `error.code`/`error.status`
 * rather than a response body. Status codes, the 423 jail path and the 401
 * belong in an `app.inject` test (see the block at the bottom of
 * `test/bank.test.ts`). A helper that resembles `registerPluginRoutes`
 * without being it is how a suite starts proving the wrong thing.
 *
 * It exists because three core test files drove `game/bank/service.ts`
 * directly before that module became a plugin, and the `travel`, `bullets`,
 * `crimes` and `gangs` ports face the same coupling.
 */
export async function callPluginRoute(
  manifest: PluginManifest,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: CallPluginRouteOptions,
): Promise<RouteResult> {
  const pluginRoute = manifest.routes.find((r) => r.method === method && r.path === path);
  if (pluginRoute === undefined) {
    // Loud, not silent: a typo'd path would otherwise make the call a no-op
    // that a passing test reads as coverage.
    throw new Error(`plugin "${manifest.id}" has no ${method} route "${path}"`);
  }

  const deps = {
    db: opts.db,
    redis: opts.redis,
    queues: new Map(),
    settings: opts.settings ?? {},
    leaderboardPrefix: opts.leaderboardPrefix,
  };

  const player = await loadSnapshot(deps, opts.playerId);
  const ctx = createPluginCtx(deps, {
    pluginId: manifest.id,
    player,
    job: null,
    filters: manifest.filters,
    propertyTypes: new Map(),
    installedPluginIds: new Set([manifest.id]),
  });

  // The route's OWN schemas, so a test cannot pass a body the real route
  // would have rejected with a 400.
  const params = pluginRoute.params.parse(opts.params ?? {});
  const body = pluginRoute.body.parse(opts.body ?? {});

  return await pluginRoute.handler(ctx, { params, body });
}
