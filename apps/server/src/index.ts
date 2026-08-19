import type { PluginManifest } from "@gl3/plugin-sdk";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { seedCrimes, seedItems, seedLocations, seedRanks } from "./db/seed.js";
import { DEFAULT_LEADERBOARD_PREFIX, rebuildLeaderboards } from "./game/leaderboard/service.js";
import { ensureCurrentRound } from "./game/rounds/service.js";
import { startSentenceSweeper } from "./game/sweep/sweeper.js";
import { buildAvailablePlugins } from "./plugins/available.js";
import { CORE_PLUGINS, withCorePlugins } from "./plugins/core-plugins.js";
import { loadDynamicPlugins, type DynamicPlugin } from "./plugins/dynamic.js";
import { INSTALLED_PLUGINS } from "./plugins/installed-plugins.js";
import { createStorageDriver } from "./assets/factory.js";
import { sweepOrphanedCoreBindings, sweepUnreferencedAssets } from "./assets/sweep.js";
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

/**
 * Fails boot when a dynamically loaded package declares an id already taken by
 * a core plugin or by a compiled-in one, naming both sides.
 *
 * `withCorePlugins` de-duplicates by id SILENTLY, which is right for its own
 * case — a core module named redundantly in `PLUGIN_IDS` should just not load
 * twice. It is wrong here: an operator who installs `@acme/casino` and gets
 * nothing has no way to discover that its id collided with ours, because the
 * plugin simply never appears. Two packages colliding with each other is
 * already caught by `buildAvailablePlugins`; this covers the two cases it
 * cannot see.
 */
function assertNoIdCollisions(
  loaded: readonly DynamicPlugin[],
  takenIds: readonly string[],
): PluginManifest[] {
  const taken = new Set(takenIds);
  return loaded.map(([packageName, manifest]) => {
    if (taken.has(manifest.id)) {
      throw new Error(
        `plugin package "${packageName}" declares id "${manifest.id}", which is already loaded — ` +
          `remove it from PLUGIN_PACKAGES or PLUGIN_IDS`,
      );
    }
    taken.add(manifest.id);
    return manifest;
  });
}

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

// Plugins the operator installed outside this build (`PLUGIN_PACKAGES`), which
// is the only route into the published image — see `plugins/dynamic.ts`.
const dynamicManifests = assertNoIdCollisions(
  await loadDynamicPlugins(config.pluginPackages, config.pluginDir),
  [...CORE_PLUGINS.map((m) => m.id), ...optionalManifests.map((m) => m.id)],
);

const manifests: PluginManifest[] = withCorePlugins([...optionalManifests, ...dynamicManifests]);

const loadedSettings = await loadSettings(db);

// Deliberately here and NOT in buildApp: every integration test builds its
// server through buildApp/bootTestServer, and a boot-time rollover firing under
// those tests would make round assertions race — the same reason the sentence
// sweeper is kept out of buildApp. The boot call is what absorbs the expensive
// case: a server that was down across several scheduled rounds settles them all
// here rather than making the first player of the day pay for it.
await ensureCurrentRound(db, redis, loadedSettings);

// One driver instance for the whole process, shared by the plugin ctx (reads,
// through `ctx.assets`) and the core asset routes (writes). Built here rather
// than twice so an `s3` misconfiguration fails once, at boot.
const assetDriver = createStorageDriver(config.assets);

const loadedPlugins = await loadPlugins(
  { db, redis, settings: loadedSettings, leaderboardPrefix: DEFAULT_LEADERBOARD_PREFIX, assetDriver },
  manifests,
);

// Passed explicitly rather than relying on buildApp's own CORE_PLUGINS
// fallback (see the comment at that seam in app.ts): production keeps its
// plugin set visible at the boot site.
const app = await buildApp(config, { db, redis, plugins: loadedPlugins, assetDriver });

await app.listen({ port: config.port, host: "0.0.0.0" });
await attachGateway(app.server, { db, redis, subscriber: createSubscriber(config.redisUrl), corsOrigins: config.corsOrigins });

// Deliberately here and NOT in buildApp: every integration test builds its
// server through buildApp/bootTestServer, and a background process quietly
// clearing jailed_until under those tests would make half of them race. In
// production the sweeper is what turns release into a WebSocket push instead
// of a client poll.
if (config.sweepIntervalMs > 0) {
  startSentenceSweeper({
    db, redis, intervalMs: config.sweepIntervalMs,
    onError: (error) => { app.log.error({ err: error }, "sentence sweep failed"); },
  });

  // Asset GC rides the same switch but at a much slower cadence: an orphaned
  // image costs storage, not correctness, and its candidates are bounded by an
  // hour-old grace period anyway. Every sixty sentence ticks is roughly every
  // two minutes at the default interval — far more often than art changes.
  //
  // Kept out of buildApp for the same reason the sentence sweeper is: every
  // integration test builds its server through buildApp/bootTestServer, and a
  // background pass deleting rows under those tests would make a whole class of
  // them race.
  const assetSweepIntervalMs = config.sweepIntervalMs * 60;
  const assetTimer = setInterval(() => {
    void (async () => {
      try {
        await sweepOrphanedCoreBindings(db);
        await sweepUnreferencedAssets(db, assetDriver);
      } catch (error) {
        app.log.error({ err: error }, "asset sweep failed");
      }
    })();
  }, assetSweepIntervalMs);
  // `unref` so a pending timer never holds the process open on shutdown — the
  // sweep is a latency optimisation, and anything it misses this run is picked
  // up next boot.
  assetTimer.unref();
}
