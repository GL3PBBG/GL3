import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { locations } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateLocations } from "../../src/migrators/locations.js";

describe("migrateLocations", () => {
  it("migrates both locations", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateLocations(pool, db, createReport(false));

      const rows = await db.select().from(locations);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.name === "Chicago")?.travelCost).toBe(100n);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
