import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { rounds } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRounds } from "../../src/migrators/rounds.js";

describe("migrateRounds", () => {
  it("migrates rounds with unix timestamps converted to Dates", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateRounds(pool, db, report);

      const rows = await db.select().from(rounds);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("Round 1");
      expect(rows[0]?.startsAt).toEqual(new Date(1700000000 * 1000));
      expect(rows[0]?.endsAt).toBeNull();
      expect(report.tables.find((t) => t.table === "rounds")).toEqual({ table: "rounds", read: 1, written: 1, skipped: 0 });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
