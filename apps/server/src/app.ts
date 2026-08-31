import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { registerAssetRoutes } from "./assets/routes.js";
import { createStorageDriver } from "./assets/factory.js";
import type { StorageDriver } from "./assets/driver.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerExtensionRoutes } from "./plugins/extension-routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { createMailDriver } from "./mail/driver.js";
import type { MailDriver } from "./mail/driver.js";
import { createOutboxDelivery } from "./bus/outbox.js";
import { registerHospitalRoutes } from "./game/hospital/routes.js";
import { registerJailRoutes } from "./game/jail/routes.js";
import { registerLeaderboardRoutes } from "./game/leaderboard/routes.js";
import { DEFAULT_LEADERBOARD_PREFIX } from "./game/leaderboard/service.js";
import { registerProfileRoutes } from "./game/profile/routes.js";
import { registerPresenceRoutes } from "./presence/routes.js";
import { registerRoundsRoutes } from "./game/rounds/routes.js";
import { registerStatsRoutes } from "./stats/routes.js";
import { collectAssetSlots } from "./plugins/asset-slots.js";
import { bundledPlugins } from "./plugins/core-plugins.js";
import { loadPlugins, type LoadedPlugins } from "./plugins/loader.js";
import { registerPluginsEndpoint } from "./plugins/manifest-endpoint.js";
import { registerPluginRoutes } from "./plugins/routes.js";
import { loadSettings } from "./settings/load.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerThemeRoutes } from "./theme/routes.js";
import { registerWsRoutes } from "./ws/routes.js";

export interface AppDeps {
  db: Db;
  redis: Redis;
  /** Overridable so tests can pair a server with a test-private leaderboard namespace — see rebuildLeaderboards. */
  leaderboardPrefix?: string;
  /** Overridable so tests can pair a server with a test-private rate-limit namespace — see bootTestServer. */
  rateLimitPrefix?: string;
  /** Loaded plugin system: validated manifests + queues + payload (from `loadPlugins`). */
  plugins?: LoadedPlugins;
  /**
   * Overridable so a test can point storage at its own temp directory rather
   * than the process-wide `ASSET_FS_ROOT` — the same reason
   * `leaderboardPrefix` and `rateLimitPrefix` above are overridable. Defaults
   * to whatever `config.assets` selects.
   */
  assetDriver?: StorageDriver;
  /** Overridable so tests can assert on outbound mail without a real provider — see mail.test.ts. Defaults to `createMailDriver(config.mail)`. */
  mail?: MailDriver;
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const loadedSettings = await loadSettings(deps.db);
  const assetDriver = deps.assetDriver ?? createStorageDriver(config.assets);
  const app = Fastify({ logger: config.nodeEnv !== "test" });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  // Several POST routes take no body (commit a crime, mint a WS ticket, travel,
  // accept/decline/leave a gang, mark read, logout). The web client sends them
  // with no content-type, which Fastify handles fine. But a reverse proxy can
  // *inject* a content-type on a bodyless POST (a common one is
  // application/x-www-form-urlencoded), and Fastify's default parser set has no
  // handler for that media type, so it returns 415
  // (FST_ERR_CTP_INVALID_MEDIA_TYPE) before the route ever runs. Register a
  // catch-all parser for every other content-type that yields an empty body for
  // an empty payload and a best-effort object otherwise — these routes never
  // read request.body, so an empty object is exactly correct, and the
  // JSON-content routes above are unaffected because Fastify only calls the
  // catch-all for types that have no more specific parser.
  app.addContentTypeParser(
    "*", // every media type without its own parser
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body.length === 0 ? {} : { raw: body.toString() });
    },
  );

  app.get("/health", async () => ({ status: "ok" }));
  // `loaded` (below) is not assigned until well after this call — pass a
  // thunk, not `loaded.manifests` itself, so /api/auth/me reads the
  // post-loadPlugins binding at request time rather than throwing
  // "Cannot access 'loaded' before initialization" at boot.
  registerAuthRoutes(
    app, config, deps.db, deps.redis, deps.mail ?? createMailDriver(config.mail), deps.rateLimitPrefix,
    () => loaded!.manifests,
  );

  const requireAuth = app.requireAuth as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  const leaderboardPrefix = deps.leaderboardPrefix ?? DEFAULT_LEADERBOARD_PREFIX;
  // Jail and hospital are combat-adjacent sentence mechanics — gangster game,
  // not framework. A framework boot registers neither; nothing can sentence a
  // player there (no crimes, no combat), so the routes would be dead weight
  // answering with never-set state.
  if (config.profile !== "framework") {
    // The thunk, not `loaded.manifests` itself — same reason as the auth
    // routes above: `loaded` is assigned after this registration runs.
    registerJailRoutes(app, deps.db, createOutboxDelivery(deps.db, { redis: deps.redis }), loadedSettings, requireAuth, () => loaded!.manifests);
    registerHospitalRoutes(app, deps.db, createOutboxDelivery(deps.db, { redis: deps.redis }), loadedSettings, requireAuth);
  }
  registerLeaderboardRoutes(app, deps.db, createOutboxDelivery(deps.db, { redis: deps.redis }), deps.redis, loadedSettings, requireAuth, leaderboardPrefix);
  registerPresenceRoutes(app, deps.db, deps.redis, requireAuth);
  registerRoundsRoutes(app, deps.db, createOutboxDelivery(deps.db, { redis: deps.redis }), loadedSettings, requireAuth);
  registerStatsRoutes(app, deps.db, deps.redis, requireAuth);
  registerThemeRoutes(app, deps.db, assetDriver);
  registerWsRoutes(app, deps.redis, requireAuth);

  // Strangler seam: plugin routes register on the same Fastify instance while
  // app.ts keeps registering un-ported modules directly (spec: Sequencing).
  // Both paths coexist for the length of M5 and the old one is deleted last.
  //
  // This app must end up with the profile's bundled plugins loaded one way or
  // another. `bootTestServer()` and `index.ts` both build their own
  // `deps.plugins` and pass it in explicitly — that always wins. But most
  // test files call `buildApp` directly with no `plugins` at all
  // (`ranks.test.ts` among them), and those callers still need a ported
  // module's route to answer rather than 404. When `deps.plugins` is
  // undefined, load the bundled set for the config's profile here instead.
  let loaded = deps.plugins;
  let ownsLoadedPlugins = false;
  if (loaded === undefined) {
    // This default path has no queue-name prefix, unlike `bootTestServer`'s
    // own `loadPlugins` call (`plugin-test-${randomUUID()}-`) — a shared
    // BullMQ queue name across concurrently-running test files has already
    // caused real cross-talk here (see the `crime-test-${randomUUID()}`
    // comment in test/helpers/server.ts). `crimes` is the first bundled
    // plugin that declares jobs, so this fallback throws on a full-profile
    // boot: every caller must pass `deps.plugins` explicitly, built with an
    // isolated queue prefix, exactly as `bootTestServer` and `index.ts`
    // already do. The guard stays even though the branch below it is now
    // unreachable — the alternative is silently creating an unprefixed,
    // unisolated queue the first time a caller forgets to pass `plugins`.
    const fallbackPlugins = bundledPlugins(config.profile, []);
    for (const manifest of fallbackPlugins) {
      if (Object.keys(manifest.jobs).length > 0) {
        throw new Error(
          `bundled plugin "${manifest.id}" declares jobs — it must be loaded by the caller with an isolated queue prefix, not by buildApp's default`,
        );
      }
    }
    loaded = await loadPlugins(
      { db: deps.db, redis: deps.redis, settings: loadedSettings, leaderboardPrefix, assetDriver },
      fallbackPlugins,
      "",
      config.profile,
    );
    ownsLoadedPlugins = true;
  }

  const pluginCtxDeps = {
    db: deps.db,
    redis: deps.redis,
    queues: loaded.queues,
    settings: loadedSettings,
    leaderboardPrefix,
    assetDriver,
  };
  registerPluginRoutes(app, loaded.manifests, pluginCtxDeps);

  // Only for plugins buildApp loaded itself: a caller-supplied `deps.plugins`
  // is owned by that caller (e.g. bootTestServer's own `close()`), and closing
  // it again here would be a double-close bug of our own making.
  if (ownsLoadedPlugins) {
    const owned = loaded;
    app.addHook("onClose", async () => {
      for (const w of owned.workers) await w.close();
      for (const q of owned.queues.values()) await q.close();
    });
  }

  // Moved here (after `loaded` resolves) rather than alongside the other
  // core routes above: this route applies the `core.profileView` filter
  // chain, which needs `loaded.coreFilters` — plugins must be loaded first.
  registerProfileRoutes(app, deps.db, deps.redis, requireAuth, loaded.coreFilters, deps.rateLimitPrefix, config.clientIpHeader);
  registerPluginsEndpoint(app, loaded.payload, loaded.coreFilters);
  registerExtensionRoutes(app, pluginCtxDeps, loaded.coreFilters);
  registerAdminRoutes(app, deps.db, deps.redis, loaded.manifests);
  // After the plugins are loaded: the bind route validates a slot against the
  // registry those manifests produce, so registering earlier would give it an
  // empty one and reject every real binding.
  registerAssetRoutes(app, {
    db: deps.db,
    driver: assetDriver,
    settings: loadedSettings,
    assetSlots: collectAssetSlots(loaded.manifests),
  });

  return app;
}
