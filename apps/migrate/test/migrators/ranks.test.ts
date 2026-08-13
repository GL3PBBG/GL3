import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { moneyRanks, ranks } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRanks } from "../../src/migrators/ranks.js";

describe("migrateRanks", () => {
  it("migrates ranks and moneyRanks with bigint conversion", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateRanks(pool, db, report);

      const rankRows = await db.select().from(ranks);
      expect(rankRows).toHaveLength(2);
      expect(rankRows.find((r) => r.name === "Soldier")?.expRequired).toBe(1000n);
      expect(typeof rankRows[0]?.expRequired).toBe("bigint");

      const moneyRankRows = await db.select().from(moneyRanks);
      expect(moneyRankRows).toHaveLength(2);
      expect(moneyRankRows.find((r) => r.label === "Rich")?.threshold).toBe(1000000n);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
