import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/client.js";
import { startCrimeWorker } from "../../src/game/crimes/worker.js";
import { createCrimeQueue } from "../../src/queue/index.js";
import { createRedis, createSubscriber } from "../../src/redis.js";
import { attachGateway } from "../../src/ws/gateway.js";

export async function bootTestServer(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const config = loadConfig({ ...process.env, NODE_ENV: "test" });
  const { db, sql } = createDb(config.databaseUrl);
  const redis = createRedis(config.redisUrl);

  // Postgres is isolated per test file (isolated-db.setup.ts), but Redis is
  // one shared instance across every file running in parallel. BullMQ's
  // "crime" queue has no such isolation by default: any worker attached to
  // the queue name can claim any job on it, regardless of which file's
  // bootTestServer() enqueued it. Under load that lets one file's job land
  // on another file's worker — which finds no matching row in its own
  // private database and silently drops the job (worker.ts's intentional
  // "crime deleted between enqueue and resolve" guard) — so the enqueuing
  // test times out waiting for an event that will never arrive. Giving each
  // bootTestServer() call its own private queue name closes that gap the
  // same way isolated-db.setup.ts closes it for Postgres.
  const queueName = `crime-test-${randomUUID()}`;
  const crimeQueue = createCrimeQueue(createRedis(config.redisUrl), queueName);
  const workerDb = createDb(config.databaseUrl);
  const workerConnection = createRedis(config.redisUrl);
  const publisher = createRedis(config.redisUrl);
  const worker = startCrimeWorker({ db: workerDb.db, connection: workerConnection, publisher, queueName });

  const app = await buildApp(config, { db, redis, crimeQueue });

  // `attachGateway` only needs `app.server`, which exists before `app.listen` is
  // called — the WS test's own `beforeAll` performs the actual `listen`.
  const gatewaySubscriber = createSubscriber(config.redisUrl);
  const gateway = await attachGateway(app.server, {
    db, redis, subscriber: gatewaySubscriber, corsOrigins: config.corsOrigins,
  });

  return {
    app,
    close: async () => {
      await gateway.close();
      await app.close();
      await worker.close();
      await crimeQueue.close();
      await workerDb.sql.end();
      publisher.disconnect();
      gatewaySubscriber.disconnect();
      await sql.end();
      redis.disconnect();
    },
  };
}
