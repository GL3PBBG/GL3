import type { PluginManifest } from "@gl3/plugin-sdk";
import helloPlugin from "@gl3/hello-plugin";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { seedCrimes, seedLocations, seedRanks } from "./db/seed.js";
import { startCrimeWorker } from "./game/crimes/worker.js";
import { rebuildLeaderboards } from "./game/leaderboard/service.js";
import { loadPlugins } from "./plugins/loader.js";
import { createCrimeQueue } from "./queue/index.js";
import { createRedis, createSubscriber } from "./redis.js";
import { attachGateway } from "./ws/gateway.js";

/**
 * The explicit id→manifest map (spec: Boot sequence step 1). A static `import`
 * is what keeps the dependency direction checkable by the compiler — the
 * example package imports only `@gl3/plugin-sdk`/`zod`/`drizzle-orm`, and a
 * dynamic `import(pluginId)` would bypass that check.
 */
const AVAILABLE_PLUGINS: Record<string, PluginManifest> = { hello: helloPlugin };

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
const redis = createRedis(config.redisUrl);

const crimeQueue = createCrimeQueue(createRedis(config.redisUrl));
await seedCrimes(db);
await seedRanks(db);
await seedLocations(db);
await rebuildLeaderboards(db, redis);
startCrimeWorker({ db, connection: createRedis(config.redisUrl), publisher: createRedis(config.redisUrl) });

// Resolve plugin ids to manifests, failing boot on an unknown id.
const manifests = config.pluginIds.map((id) => {
  const manifest = AVAILABLE_PLUGINS[id];
  if (manifest === undefined) throw new Error(`unknown plugin id "${id}" — no entry in AVAILABLE_PLUGINS`);
  return manifest;
});

const loadedPlugins = manifests.length > 0
  ? await loadPlugins({ db, redis, settings: {} }, manifests)
  : undefined;

const app = await buildApp(config, loadedPlugins !== undefined
  ? { db, redis, crimeQueue, plugins: loadedPlugins }
  : { db, redis, crimeQueue });

await app.listen({ port: config.port, host: "0.0.0.0" });
await attachGateway(app.server, { db, redis, subscriber: createSubscriber(config.redisUrl), corsOrigins: config.corsOrigins });
