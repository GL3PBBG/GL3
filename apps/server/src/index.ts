import type { PluginManifest } from "@gl3/plugin-sdk";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { bootSeedsFor, seedCrimes, seedItems, seedLocations, seedRanks } from "./db/seed.js";
import { DEFAULT_LEADERBOARD_PREFIX, rebuildLeaderboards } from "./game/leaderboard/service.js";
import { ensureCurrentRound } from "./game/rounds/service.js";
import { startSentenceSweeper } from "./game/sweep/sweeper.js";
import { startWealthTaxLoop } from "./economy/tax.js";
import { buildAvailablePlugins } from "./plugins/available.js";
import { CORE_PLUGINS, bundledPlugins } from "./plugins/core-plugins.js";
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
 * would bypass that check. Framework plugins (ranks, bank, mail, ...) are
 * not looked up here — they load in every profile through `bundledPlugins`.
 * The gameplay plugins ARE here as well as in `GAMEPLAY_PLUGINS`: the full
 * profile loads them automatically, and under `GL3_PROFILE=framework`
 * `PLUGIN_IDS` is the only way they load.
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
 * `bundledPlugins` de-duplicates by id SILENTLY, which is right for its own
 * case — a bundled plugin named redundantly in `PLUGIN_IDS` should just not
 * load twice. It is wrong here: an operator who installs `@acme/casino` and gets
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

// Resolve the plugin set BEFORE seeding: which seeds run is a function of
// which plugins loaded (seedCrimes without the crimes plugin would fill a
// table no route reads; seedLocations without travel/bullets seeds cities
// nobody can reach).
const optionalManifests = config.pluginIds.map((id) => {
  const manifest = AVAILABLE_PLUGINS[id];
  if (manifest === undefined) throw new Error(`unknown plugin id "${id}" — no entry in AVAILABLE_PLUGINS`);
  return manifest;
});

// Plugins the operator installed outside this build (`PLUGIN_PACKAGES`), which
// is the only route into the published image — see `plugins/dynamic.ts`.
// Collision detection names the whole bundled set regardless of profile: an
// id our gameplay plugins own is taken even under a framework boot that left
// them unloaded — loading both in one boot is impossible either way.
const dynamicManifests = assertNoIdCollisions(
  await loadDynamicPlugins(config.pluginPackages, config.pluginDir),
  [...CORE_PLUGINS.map((m) => m.id), ...optionalManifests.map((m) => m.id)],
);

const manifests: PluginManifest[] = bundledPlugins(config.profile, [...optionalManifests, ...dynamicManifests]);

// Sample content, gated on the plugins that read it — see bootSeedsFor.
const seeds = bootSeedsFor(manifests.map((m) => m.id));
if (seeds.crimes) await seedCrimes(db);
await seedRanks(db);
if (seeds.locations) await seedLocations(db);
if (seeds.items) await seedItems(db);
await rebuildLeaderboards(db, redis);

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
  "",
  config.profile,
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
//
// The sentence sweeper and the wealth tax are gangster-game loops: a
// framework boot has no crimes or combat, so nobody can be sentenced, and a
// player-cash tax is not something an openPBBG-shaped game inherits silently.
// Asset GC is not gameplay — avatars and plugin art exist in every profile —
// so it alone rides the switch under framework.
if (config.profile !== "framework" && config.sweepIntervalMs > 0) {
  startSentenceSweeper({
    db, redis, intervalMs: config.sweepIntervalMs,
    onError: (error) => { app.log.error({ err: error }, "sentence sweep failed"); },
  });

  // The daily wealth tax rides the same switch. Its loop's first tick fires
  // immediately — the boot call is what absorbs downtime, so a server that was
  // dark at midnight taxes on its first morning tick rather than a day late.
  // Cadence is a fixed 60s, not the sweep interval: the work is day-granular
  // and the common tick is one indexed settings-row read (the unlocked cursor
  // pre-check), so checking often costs nothing and the day never starts late
  // by more than a minute. Out of buildApp for the sweeper's reason: a
  // background debit under bootTestServer would race every balance assertion.
  startWealthTaxLoop({
    db, settings: loadedSettings, intervalMs: 60_000,
    onError: (error) => { app.log.error({ err: error }, "wealth tax settle failed"); },
  });
}

if (config.sweepIntervalMs > 0) {
  // Asset GC at a much slower cadence: an orphaned image costs storage, not
  // correctness, and its candidates are bounded by an hour-old grace period
  // anyway. Every sixty sweep intervals is roughly every two minutes at the
  // default — far more often than art changes.
  //
  // Kept out of buildApp for the same reason the sentence sweeper is: every
  // integration test builds its server through buildApp/bootTestServer, and a
  // background pass deleting rows under those tests would make a whole class
  // of them race.
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
