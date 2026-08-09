import cors from "@fastify/cors";
import type { Queue } from "bullmq";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { registerBankRoutes } from "./game/bank/routes.js";
import { registerBulletsRoutes } from "./game/bullets/routes.js";
import { registerCrimeRoutes } from "./game/crimes/routes.js";
import { registerGangRoutes } from "./game/gangs/routes.js";
import { registerJailRoutes } from "./game/jail/routes.js";
import { registerLeaderboardRoutes } from "./game/leaderboard/routes.js";
import { registerMailRoutes } from "./game/mail/routes.js";
import { registerNewsRoutes } from "./game/news/routes.js";
import { registerNotificationRoutes } from "./game/notifications/routes.js";
import { registerProfileRoutes } from "./game/profile/routes.js";
import { registerRankRoutes } from "./game/ranks/routes.js";
import { registerTravelRoutes } from "./game/travel/routes.js";
import type { LoadedPlugins } from "./plugins/loader.js";
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
  registerBankRoutes(app, deps.db, deps.redis, requireAuth);
  registerBulletsRoutes(app, deps.db, deps.redis, requireAuth);
  registerCrimeRoutes(app, deps.db, deps.redis, deps.crimeQueue, requireAuth);
  registerGangRoutes(app, deps.db, deps.redis, requireAuth);
  registerJailRoutes(app, deps.db, deps.redis, requireAuth);
  registerLeaderboardRoutes(app, deps.db, deps.redis, requireAuth, deps.leaderboardPrefix);
  registerMailRoutes(app, deps.db, deps.redis, requireAuth);
  registerNewsRoutes(app, deps.db, deps.redis, requireAuth);
  registerNotificationRoutes(app, deps.db, requireAuth);
  registerProfileRoutes(app, deps.db, requireAuth);
  registerRankRoutes(app, deps.db, requireAuth);
  registerTravelRoutes(app, deps.db, deps.redis, requireAuth);
  registerWsRoutes(app, deps.redis, requireAuth);

  // Strangler seam: plugin routes register on the same Fastify instance while
  // app.ts keeps registering un-ported modules directly (spec: Sequencing).
  // Both paths coexist for the length of M5 and the old one is deleted last.
  const loaded = deps.plugins;
  if (loaded !== undefined) {
    registerPluginRoutes(app, loaded.manifests, {
      db: deps.db,
      redis: deps.redis,
      queues: loaded.queues,
      settings: {},
    });
    registerPluginsEndpoint(app, loaded.payload);
  }

  return app;
}
