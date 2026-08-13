import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { settings } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateSettings } from "../../src/migrators/settings.js";

describe("migrateSettings", () => {
  it("migrates key/value settings verbatim and stays idempotent on re-run", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await migrateSettings(pool, db, createReport(false));
      await migrateSettings(pool, db, createReport(false)); // re-run

      const rows = await db.select().from(settings);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.key === "gangName")?.value).toBe("Family");

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
