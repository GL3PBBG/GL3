import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createRedis } from "./redis.js";

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
const redis = createRedis(config.redisUrl);
const app = await buildApp(config, { db, redis });

await app.listen({ port: config.port, host: "0.0.0.0" });
