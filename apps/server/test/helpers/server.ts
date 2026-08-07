import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/client.js";
import { createRedis } from "../../src/redis.js";

export async function bootTestServer(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const config = loadConfig({ ...process.env, NODE_ENV: "test" });
  const { db, sql } = createDb(config.databaseUrl);
  const redis = createRedis(config.redisUrl);
  const app = await buildApp(config, { db, redis });
  return {
    app,
    close: async () => { await app.close(); await sql.end(); redis.disconnect(); },
  };
}
