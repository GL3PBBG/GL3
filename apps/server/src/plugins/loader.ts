import type { PluginManifest } from "@gl3/plugin-sdk";
import type { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { buildPluginsPayload, type PluginsPayload } from "./manifest-endpoint.js";
import { createPluginQueues, createPluginWorkers } from "./jobs.js";
import { runPluginMigrations } from "./migrate.js";
import { validatePlugins } from "./validate.js";
import type { Db } from "../db/client.js";

export interface LoadedPlugins {
  manifests: readonly PluginManifest[];
  payload: PluginsPayload;
  queues: Map<string, Queue>;
  workers: Worker[];
}

export interface LoadPluginsDeps {
  db: Db;
  redis: Redis;
  settings: Record<string, string>;
}

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
    { db: deps.db, redis: deps.redis, queues, settings: deps.settings },
    manifests,
    queuePrefix,
  );
  return { manifests, payload: buildPluginsPayload(manifests), queues, workers };
}
