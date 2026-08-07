import cors from "@fastify/cors";
import type { Queue } from "bullmq";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { registerCrimeRoutes } from "./game/crimes/routes.js";
import { registerJailRoutes } from "./game/jail/routes.js";
import { registerRankRoutes } from "./game/ranks/routes.js";
import type { CrimeJobData } from "./queue/index.js";
import { registerWsRoutes } from "./ws/routes.js";

export interface AppDeps { db: Db; redis: Redis; crimeQueue: Queue<CrimeJobData> }

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv !== "test" });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, config, deps.db, deps.redis);

  const requireAuth = app.requireAuth as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  registerCrimeRoutes(app, deps.db, deps.redis, deps.crimeQueue, requireAuth);
  registerJailRoutes(app, deps.db, deps.redis, requireAuth);
  registerRankRoutes(app, deps.db, requireAuth);
  registerWsRoutes(app, deps.redis, requireAuth);

  return app;
}
