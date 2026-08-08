import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { seedCrimes, seedLocations, seedRanks } from "./db/seed.js";
import { startCrimeWorker } from "./game/crimes/worker.js";
import { rebuildLeaderboards } from "./game/leaderboard/service.js";
import { createCrimeQueue } from "./queue/index.js";
import { createRedis, createSubscriber } from "./redis.js";
import { attachGateway } from "./ws/gateway.js";

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
const redis = createRedis(config.redisUrl);

const crimeQueue = createCrimeQueue(createRedis(config.redisUrl));
await seedCrimes(db);
await seedRanks(db);
await seedLocations(db);
await rebuildLeaderboards(db, redis);
startCrimeWorker({ db, connection: createRedis(config.redisUrl), publisher: createRedis(config.redisUrl) });
const app = await buildApp(config, { db, redis, crimeQueue });

await app.listen({ port: config.port, host: "0.0.0.0" });
await attachGateway(app.server, { db, redis, subscriber: createSubscriber(config.redisUrl), corsOrigins: config.corsOrigins });
