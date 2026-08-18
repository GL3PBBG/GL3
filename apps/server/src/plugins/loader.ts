import type { PluginManifest } from "@gl3/plugin-sdk";
import type { Queue, Worker } from "bullmq";
import { buildPluginsPayload, type PluginsPayload } from "./manifest-endpoint.js";
import { createPluginQueues, createPluginWorkers } from "./jobs.js";
import { runPluginMigrations } from "./migrate.js";
import { validatePlugins } from "./validate.js";
import type { PluginCtxDeps } from "./ctx.js";

export interface LoadedPlugins {
  manifests: readonly PluginManifest[];
  payload: PluginsPayload;
  queues: Map<string, Queue>;
  workers: Worker[];
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
  return { manifests, payload: buildPluginsPayload(manifests), queues, workers };
}
