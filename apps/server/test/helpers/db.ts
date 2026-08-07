import { sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";

export function testDb(): ReturnType<typeof createDb> {
  return createDb(loadConfig(process.env).databaseUrl);
}

/** Wipes game data between tests. Excludes drizzle's own bookkeeping table. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`
    DO $$
    DECLARE t text;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I CASCADE', t);
      END LOOP;
    END $$;
  `);
}
