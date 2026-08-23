import type { PluginManifest } from "@gl3/plugin-sdk";
import type { Queue, Worker } from "bullmq";
import { buildCoreFilters, type CoreFilters } from "./core-filters.js";
import { buildPluginsPayload, type Gl3Profile, type PluginsPayload } from "./manifest-endpoint.js";
import { createPluginQueues, createPluginWorkers } from "./jobs.js";
import { runPluginMigrations } from "./migrate.js";
import { validatePlugins } from "./validate.js";
import type { PluginCtxDeps } from "./ctx.js";

export interface LoadedPlugins {
  manifests: readonly PluginManifest[];
  payload: PluginsPayload;
  queues: Map<string, Queue>;
  workers: Worker[];
  /** Core routes' one applier for the five core-owned filter points
   *  (`core.profileView`, `core.dashboard`, `core.hud`, `core.menuBadges`,
   *  `core.moneyFormat`) — Tasks 7-8 call it; a plugin route never sees it. */
  coreFilters: CoreFilters;
}

/**
 * The loader needs everything a plugin ctx needs except the queues, which the
 * loader itself creates. Derived from `PluginCtxDeps` so a future field added
 * to the ctx propagates here automatically rather than rotting into a second
 * copy that drifts.
 */
export type LoadPluginsDeps = Omit<PluginCtxDeps, "queues">;

/**
 * Boot sequence steps 2-6 (spec). Step 1 — resolving ids to packages — is the
 * caller's, because a static `import` is what keeps the dependency direction
 * checkable by the compiler; a dynamic import by id would not be.
 *
 * Every failure here is a hard boot failure naming the plugin id.
 */
export async function loadPlugins(
  deps: LoadPluginsDeps,
  manifests: readonly PluginManifest[],
  queuePrefix = "",
  profile: Gl3Profile = "full",
): Promise<LoadedPlugins> {
  validatePlugins(manifests);
  await runPluginMigrations(deps.db, manifests);
  const queues = createPluginQueues(deps.redis, manifests, queuePrefix);
  const workers = createPluginWorkers(
    {
      db: deps.db, redis: deps.redis, queues, settings: deps.settings,
      leaderboardPrefix: deps.leaderboardPrefix, assetDriver: deps.assetDriver,
    },
    manifests,
    queuePrefix,
  );
  // Built last, after queues/workers exist: a core-owned filter point's
  // subscriber ctx needs `ctx.jobs.enqueue`, same as any plugin route's ctx,
  // which is only wireable once `queues` is populated. The profile threads
  // through to decide the synthetic core pages (jail/hospital) — see
  // `buildPluginsPayload`.
  const coreFilters = buildCoreFilters({ ...deps, queues }, manifests);
  return { manifests, payload: buildPluginsPayload(manifests, profile), queues, workers, coreFilters };
}
