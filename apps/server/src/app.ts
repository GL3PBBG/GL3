import cors from "@fastify/cors";
import type { Queue } from "bullmq";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { registerCrimeRoutes } from "./game/crimes/routes.js";
import { registerGangRoutes } from "./game/gangs/routes.js";
import { registerJailRoutes } from "./game/jail/routes.js";
import { registerLeaderboardRoutes } from "./game/leaderboard/routes.js";
import { DEFAULT_LEADERBOARD_PREFIX } from "./game/leaderboard/service.js";
import { registerMailRoutes } from "./game/mail/routes.js";
import { registerProfileRoutes } from "./game/profile/routes.js";
import { CORE_PLUGINS } from "./plugins/core-plugins.js";
import { loadPlugins, type LoadedPlugins } from "./plugins/loader.js";
import { registerPluginsEndpoint } from "./plugins/manifest-endpoint.js";
import { registerPluginRoutes } from "./plugins/routes.js";
import type { CrimeJobData } from "./queue/index.js";
import { registerWsRoutes } from "./ws/routes.js";

export interface AppDeps {
  db: Db;
  redis: Redis;
  crimeQueue: Queue<CrimeJobData>;
  /** Overridable so tests can pair a server with a test-private leaderboard namespace — see rebuildLeaderboards. */
  leaderboardPrefix?: string;
  /** Overridable so tests can pair a server with a test-private rate-limit namespace — see bootTestServer. */
  rateLimitPrefix?: string;
  /** Loaded plugin system: validated manifests + queues + payload (from `loadPlugins`). */
  plugins?: LoadedPlugins;
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
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
  registerAuthRoutes(app, config, deps.db, deps.redis, deps.rateLimitPrefix);

  const requireAuth = app.requireAuth as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  const leaderboardPrefix = deps.leaderboardPrefix ?? DEFAULT_LEADERBOARD_PREFIX;
  registerCrimeRoutes(app, deps.db, deps.redis, deps.crimeQueue, requireAuth);
  registerGangRoutes(app, deps.db, deps.redis, requireAuth);
  registerJailRoutes(app, deps.db, deps.redis, requireAuth);
  registerLeaderboardRoutes(app, deps.db, deps.redis, requireAuth, leaderboardPrefix);
  registerMailRoutes(app, deps.db, deps.redis, requireAuth);
  registerProfileRoutes(app, deps.db, requireAuth);
  registerWsRoutes(app, deps.redis, requireAuth);

  // Strangler seam: plugin routes register on the same Fastify instance while
  // app.ts keeps registering un-ported modules directly (spec: Sequencing).
  // Both paths coexist for the length of M5 and the old one is deleted last.
  //
  // A ported core module is never optional, so this app must end up with
  // CORE_PLUGINS loaded one way or another. `bootTestServer()` and `index.ts`
  // both build their own `deps.plugins` (CORE_PLUGINS plus whatever optional
  // manifests were selected) and pass it in explicitly — that always wins.
  // But most test files call `buildApp` directly with no `plugins` at all
  // (`ranks.test.ts` among them), and those callers still need a ported
  // module's route to answer rather than 404. When `deps.plugins` is
  // undefined, load CORE_PLUGINS here instead.
  let loaded = deps.plugins;
  let ownsLoadedPlugins = false;
  if (loaded === undefined) {
    // This default path has no queue-name prefix, unlike `bootTestServer`'s
    // own `loadPlugins` call (`plugin-test-${randomUUID()}:`) — a shared
    // BullMQ queue name across concurrently-running test files has already
    // caused real cross-talk here (see the `crime-test-${randomUUID()}`
    // comment in test/helpers/server.ts). No CORE_PLUGINS manifest declares
    // jobs today, so the gap is theoretical; keep it that way rather than
    // silently creating an unprefixed, unisolated queue the first time one
    // does. A core plugin that needs jobs must be passed to `buildApp`
    // explicitly by a caller that can supply an isolated prefix.
    for (const manifest of CORE_PLUGINS) {
      if (Object.keys(manifest.jobs).length > 0) {
        throw new Error(
          `core plugin "${manifest.id}" declares jobs — it must be loaded by the caller with an isolated queue prefix, not by buildApp's default`,
        );
      }
    }
    loaded = await loadPlugins({ db: deps.db, redis: deps.redis, settings: {}, leaderboardPrefix }, CORE_PLUGINS);
    ownsLoadedPlugins = true;
  }

  registerPluginRoutes(app, loaded.manifests, {
    db: deps.db,
    redis: deps.redis,
    queues: loaded.queues,
    settings: {},
    leaderboardPrefix,
  });

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

  registerPluginsEndpoint(app, loaded.payload);

  return app;
}
