import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl);
await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
await sql.end();
