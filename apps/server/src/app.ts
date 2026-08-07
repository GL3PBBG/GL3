import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv !== "test" });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
