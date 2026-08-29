import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { crimes } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateCrimes } from "../../src/migrators/crimes.js";

describe("migrateCrimes", () => {
  it("migrates the 6 crimes (id gap at 4 is a source-data fact, not a migrator concern here)", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateCrimes(pool, db, report);

      const rows = await db.select().from(crimes);
      expect(rows).toHaveLength(6);
      const gta = rows.find((r) => r.name === "Grand Theft Auto");
      expect(gta?.minPayout).toBe(500n);
      expect(gta?.maxPayout).toBe(2000n);
      expect(gta?.cooldownSeconds).toBe(600);
      // C_level -> min_level, the gate the plugin now enforces: GTA's C_level
      // is 5, Pickpocket's is 0 (ungated) — the fixture's own spread.
      expect(gta?.minLevel).toBe(5);
      expect(rows.find((r) => r.name === "Pickpocket")?.minLevel).toBe(0);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
