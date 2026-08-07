import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; sql: postgres.Sql } {
  const sql = postgres(databaseUrl, { max: 10 });
  return { db: drizzle(sql, { schema }), sql };
}
