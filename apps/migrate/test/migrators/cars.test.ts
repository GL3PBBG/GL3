import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { cars, theftTiers } from "../../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateCars } from "../../src/migrators/cars.js";

describe("migrateCars", () => {
  it("migrates cars (theftWeight, not a percentage) and theft tiers (cash bounds, not car ids)", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateCars(pool, db, createReport(false));

      const carRows = await db.select().from(cars);
      expect(carRows).toHaveLength(2);
      expect(carRows.find((c) => c.name === "Sports Car")?.theftWeight).toBe(2);

      const theftRows = await db.select().from(theftTiers);
      expect(theftRows).toHaveLength(1);
      expect(theftRows[0]?.minCarValue).toBe(1000n);
      expect(theftRows[0]?.maxCarValue).toBe(10000n);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
