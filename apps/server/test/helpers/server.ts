import { randomUUID } from "node:crypto";
import type { PluginManifest } from "@gl3/plugin-sdk";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { buildApp } from "../../src/app.js";
import type { FilesystemDriver } from "../../src/assets/fs-driver.js";
import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/client.js";
import { rebuildLeaderboards } from "../../src/game/leaderboard/service.js";
import { withCorePlugins, bundledPlugins } from "../../src/plugins/core-plugins.js";
import { loadPlugins, type LoadedPlugins } from "../../src/plugins/loader.js";
import { loadSettings } from "../../src/settings/load.js";
import { createRedis, createSubscriber } from "../../src/redis.js";
import { attachGateway } from "../../src/ws/gateway.js";
import { testAssetDriver } from "./assets.js";

export async function bootTestServer(
  options?: { plugins?: readonly PluginManifest[]; profile?: "full" | "framework" },
): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
  plugins: LoadedPlugins;
  assetDriver: FilesystemDriver;
  /** The same Redis client the app itself uses — exposed so a test can read a
   * key the app wrote (e.g. an `emailverify:*` verification code) without
   * opening a second connection. See `registerVerifiedPlayer`. */
  redis: Redis;
}> {
  // GL3_PROFILE is pinned per call, not inherited: an ambient variable in a
  // developer's shell must not flip a test file's plugin set.
  const config = loadConfig({ ...process.env, NODE_ENV: "test", GL3_PROFILE: options?.profile ?? "full" });
  const { db, sql } = createDb(config.databaseUrl);
  const redis = createRedis(config.redisUrl);

  // Same problem, same fix, as queueName previously used for the crimes
  // BullMQ queue (now gone — the crimes worker is a plugin worker, started
  // and isolated per-call by loadPlugins below): leaderboard:* keys are
  // global by design in production (one Redis, one game — spec §2.2), but
  // that means every bootTestServer() call sweeping ITS OWN isolated
  // Postgres DB into those same shared keys would race every other
  // concurrently-running file's sweep. A private namespace per call keeps
  // this server's rebuild, live recordScore writes, and GET
  // /api/leaderboard/:kind reads all pointed at the same isolated set of
  // Redis keys nobody else can touch.
  const leaderboardPrefix = `leaderboard-test-${randomUUID()}`;

  // Same problem, same fix, as leaderboardPrefix above:
  // /api/auth/register and /api/auth/login are rate-limited per IP via
  // ratelimit:<name>:<ip> keys in the same shared Redis, and Fastify's
  // inject() reports the same default 127.0.0.1 for every test file. Without
  // a private prefix, one file's registrations count against every other
  // concurrently-running file's bucket and can trip a false 429 that looks
  // like an auth bug but isn't (see rate-limit-isolation.setup.ts for the
  // backstop this still leaves for tests that call buildApp() directly).
  const rateLimitPrefix = `ratelimit-test-${randomUUID()}`;

  await rebuildLeaderboards(db, redis, leaderboardPrefix);

  const loadedTestSettings = await loadSettings(db);

  // Always run the full boot sequence (validate → migrate → queues/workers)
  // the same way production does, so a test exercises the real loader path.
  // `withCorePlugins` is what makes that true: a ported core module is never
  // optional, so production always loads CORE_PLUGINS alongside whatever
  // optional manifests it selects, and this boot does the same regardless of
  // whether the caller passed any of its own. This can no longer be left to
  // buildApp's own no-`deps.plugins` fallback (see the comment at that seam
  // in app.ts): that fallback deliberately throws for a CORE_PLUGIN that
  // declares jobs, of which the crimes plugin is now the first, so a
  // `bootTestServer()` call must always supply `deps.plugins` itself, not
  // just when the caller wants extra optional manifests. The random queue
  // prefix isolates plugin BullMQ queues (including the crimes plugin's)
  // from each other and from other test files' queues in the same shared
  // Redis.
  // Per boot, never the process-wide ASSET_FS_ROOT: storage is the one shared
  // resource the asset cluster adds, and the leaderboard/rate-limit prefixes
  // above exist because every other shared resource here has already caused a
  // cross-talk failure that read as a real regression.
  const assetDriver = testAssetDriver();

  const loadedPlugins = await loadPlugins(
    { db, redis, settings: loadedTestSettings, leaderboardPrefix, assetDriver },
    // Full-profile boots keep the historical merge (every bundled plugin plus
    // the caller's extras); a framework boot loads the game-agnostic subset —
    // the same selection production makes through bundledPlugins.
    options?.profile === "framework"
      ? bundledPlugins("framework", options.plugins ?? [])
      : withCorePlugins(options?.plugins ?? []),
    `plugin-test-${randomUUID()}-`,
    config.profile,
  );

  const app = await buildApp(config, {
    db, redis, leaderboardPrefix, rateLimitPrefix, plugins: loadedPlugins, assetDriver,
  });

  // `attachGateway` only needs `app.server`, which exists before `app.listen` is
  // called — the WS test's own `beforeAll` performs the actual `listen`.
  const gatewaySubscriber = createSubscriber(config.redisUrl);
  const gateway = await attachGateway(app.server, {
    db, redis, subscriber: gatewaySubscriber, corsOrigins: config.corsOrigins,
  });

  return {
    app,
    // Exposed so a file that ALSO drives a plugin job manually (runPluginJob,
    // for a pinned seed or pinned settings) can pause the matching queue and
    // stop the live worker started above from racing it. Purely additive —
    // every other caller destructures `{ app, close }` and is unaffected.
    plugins: loadedPlugins,
    // Exposed so an asset test can read the stored bytes back out of the very
    // driver the server wrote them through.
    assetDriver,
    redis,
    close: async () => {
      for (const w of loadedPlugins.workers) await w.close();
      for (const q of loadedPlugins.queues.values()) await q.close();
      await gateway.close();
      await app.close();
      gatewaySubscriber.disconnect();
      await sql.end();
      redis.disconnect();
    },
  };
}
