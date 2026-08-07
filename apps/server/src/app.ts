import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";

export interface AppDeps { db: Db; redis: Redis }

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv !== "test" });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, config, deps.db, deps.redis);

  return app;
}
