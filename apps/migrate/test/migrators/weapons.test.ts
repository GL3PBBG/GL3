import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { weapons } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateWeapons } from "../../src/migrators/weapons.js";

describe("migrateWeapons", () => {
  it("migrates both weapons", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateWeapons(pool, db, createReport(false));
      const rows = await db.select().from(weapons);
      expect(rows).toHaveLength(2);
      expect(rows.find((w) => w.name === "Pistol")?.accuracy).toBe(60);
      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
