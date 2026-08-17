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
 *
 * ONE `TRUNCATE a, b, c ... CASCADE`, not a loop of one statement per table.
 * That is not a style preference, it is most of this suite's wall clock. The
 * per-table loop this replaced cost **1.32s** against 41 EMPTY tables; the
 * single statement costs **0.25s** — 5.3x, and none of it is data, it is 39
 * separate statements each paying its own WAL flush and lock acquisition.
 * `resetDb` is called from ~87 test files, most of them per test, so that
 * ~1.07s was landing on the majority of the suite's 776 integration tests.
 *
 * It also explains the contention: six workers each firing 39 small
 * WAL-flushing statements per test compete for one Postgres instance's disk,
 * which is why a file measured 2.1s/test alone and 9.8s/test inside the full
 * run while node itself sat idle. Truncating in one statement cuts the flush
 * count by the same factor it cuts the statements.
 *
 * (`synchronous_commit = off` was measured too and bought nothing once the
 * statements were batched — the cost was per-statement overhead, not fsync
 * durability.)
 *
 * CASCADE stays: with every table named in one statement it is technically
 * redundant, but a partial-table variant of this helper would need it and
 * removing it buys nothing measurable.
 */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`
    DO $$
    DECLARE stmt text;
    BEGIN
      SELECT 'TRUNCATE TABLE ' || string_agg(format('%I', tablename), ', ') || ' CASCADE'
        INTO stmt
        FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT IN ('__drizzle_migrations', 'plugin_migrations');
      IF stmt IS NOT NULL THEN
        EXECUTE stmt;
      END IF;
    END $$;
  `);
}
