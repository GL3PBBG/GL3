import type { PluginManifest } from "@gl3/plugin-sdk";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { seedCrimes, seedItems, seedLocations, seedRanks } from "./db/seed.js";
import { DEFAULT_LEADERBOARD_PREFIX, rebuildLeaderboards } from "./game/leaderboard/service.js";
import { buildAvailablePlugins } from "./plugins/available.js";
import { withCorePlugins } from "./plugins/core-plugins.js";
import { INSTALLED_PLUGINS } from "./plugins/installed-plugins.js";
import { loadPlugins } from "./plugins/loader.js";
import { loadSettings } from "./settings/load.js";
import { createRedis, createSubscriber } from "./redis.js";
import { attachGateway } from "./ws/gateway.js";

/**
 * The explicit id→manifest map for OPTIONAL plugins (spec: Boot sequence
 * step 1). A static `import` is what keeps the dependency direction
 * checkable by the compiler — the example package imports only
 * `@gl3/plugin-sdk`/`zod`/`drizzle-orm`, and a dynamic `import(pluginId)`
 * would bypass that check. Ported core modules are not looked up here — they
 * live in `CORE_PLUGINS` and load unconditionally, never gated by
 * `PLUGIN_IDS`.
 *
 * Those static imports are now GENERATED rather than hand-written:
 * `installed-plugins.ts` is produced by `npm run plugins:generate` from
 * apps/server's direct dependencies that declare `"gl3": { "plugin": true }`.
 * Installing a marketplace plugin is therefore a dependency plus a regenerate
 * — never an edit to this file, which is what stops every operator from
 * forking core. The compiler check survives because the generated imports are
 * still static; only the authorship changed.
 */
const AVAILABLE_PLUGINS: Record<string, PluginManifest> = buildAvailablePlugins(INSTALLED_PLUGINS);

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
const redis = createRedis(config.redisUrl);

await seedCrimes(db);
await seedRanks(db);
await seedLocations(db);
await seedItems(db);
await rebuildLeaderboards(db, redis);

// Resolve optional plugin ids to manifests, failing boot on an unknown id.
const optionalManifests = config.pluginIds.map((id) => {
  const manifest = AVAILABLE_PLUGINS[id];
  if (manifest === undefined) throw new Error(`unknown plugin id "${id}" — no entry in AVAILABLE_PLUGINS`);
  return manifest;
});

const manifests: PluginManifest[] = withCorePlugins(optionalManifests);

const loadedSettings = await loadSettings(db);
const loadedPlugins = await loadPlugins(
  { db, redis, settings: loadedSettings, leaderboardPrefix: DEFAULT_LEADERBOARD_PREFIX },
  manifests,
);

// Passed explicitly rather than relying on buildApp's own CORE_PLUGINS
// fallback (see the comment at that seam in app.ts): production keeps its
// plugin set visible at the boot site.
const app = await buildApp(config, { db, redis, plugins: loadedPlugins });

await app.listen({ port: config.port, host: "0.0.0.0" });
await attachGateway(app.server, { db, redis, subscriber: createSubscriber(config.redisUrl), corsOrigins: config.corsOrigins });
