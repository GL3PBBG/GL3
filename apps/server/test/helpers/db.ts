import { sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";

export function testDb(): ReturnType<typeof createDb> {
  return createDb(loadConfig(process.env).databaseUrl);
}

/**
 * Wipes game data between tests. Excludes drizzle's own bookkeeping table
 * AND `plugin_migrations`: that table is migration state, not test data —
 * TRUNCATEing it empties the tracking row but leaves a plugin's own DDL
 * (e.g. inventory's `p_inventory_shop_stock`, a plain `CREATE TABLE`, no `IF
 * NOT EXISTS`) standing, so a second `bootTestServer()`/`runPluginMigrations`
 * call in the same file re-runs the DDL against a table that was never
 * dropped and throws 42P07 "relation already exists". See
 * test/plugin-migrate.test.ts's "survives a resetDb() between boots" test.
 */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`
    DO $$
    DECLARE t text;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT IN ('__drizzle_migrations', 'plugin_migrations')
      LOOP
        EXECUTE format('TRUNCATE TABLE %I CASCADE', t);
      END LOOP;
    END $$;
  `);
}
