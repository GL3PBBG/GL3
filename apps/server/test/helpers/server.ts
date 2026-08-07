import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/client.js";
import { startCrimeWorker } from "../../src/game/crimes/worker.js";
import { createCrimeQueue } from "../../src/queue/index.js";
import { createRedis } from "../../src/redis.js";

export async function bootTestServer(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const config = loadConfig({ ...process.env, NODE_ENV: "test" });
  const { db, sql } = createDb(config.databaseUrl);
  const redis = createRedis(config.redisUrl);

  const crimeQueue = createCrimeQueue(createRedis(config.redisUrl));
  const workerDb = createDb(config.databaseUrl);
  const workerConnection = createRedis(config.redisUrl);
  const publisher = createRedis(config.redisUrl);
  const worker = startCrimeWorker({ db: workerDb.db, connection: workerConnection, publisher });

  const app = await buildApp(config, { db, redis, crimeQueue });
  return {
    app,
    close: async () => {
      await app.close();
      await worker.close();
      await crimeQueue.close();
      await workerDb.sql.end();
      publisher.disconnect();
      await sql.end();
      redis.disconnect();
    },
  };
}
