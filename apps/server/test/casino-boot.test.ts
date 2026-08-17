import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

// testDb() returns { db, sql } — createDb's pair, module-scoped and closed
// once in afterAll, as combat-log-schema.test.ts:10 does. `casino` is a
// CORE_PLUGIN (core-plugins.ts), so a bare bootTestServer() with no
// `plugins` option already migrates it via withCorePlugins — no explicit
// runPluginMigrations call needed here.
const { db, sql: conn } = testDb();

afterAll(async () => {
  await conn.end();
});

describe("casino plugin boot", () => {
  it("creates its table and its one-open-session partial index", async () => {
    const { close } = await bootTestServer();
    try {
      const cols = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'p_casino_sessions' ORDER BY column_name`);
      expect(cols.map((r) => r.column_name)).toContain("property_id");

      const idx = await db.execute(sql`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'p_casino_sessions_one_open'`);
      expect(idx).toHaveLength(1);
      expect(String(idx[0]?.indexdef)).toContain("WHERE (status = 'open'");
    } finally {
      await close();
    }
  });
});
