import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { membershipPackages } from "../../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateMembership } from "../../src/migrators/membership.js";

describe("migrateMembership", () => {
  it("migrates premiumMembership into p_membership_packages", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateMembership(pool, db, report);

      const rows = await db.select().from(membershipPackages);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "VIP Week", costPoints: 500n, durationSeconds: 604800 });

      const tableReport = report.tables.find((t) => t.table === "premiumMembership");
      expect(tableReport).toEqual({ table: "premiumMembership", read: 1, written: 1, skipped: 0 });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("is idempotent: running twice does not duplicate rows", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await migrateMembership(pool, db, createReport(false));
      await migrateMembership(pool, db, createReport(false));

      expect(await db.select().from(membershipPackages)).toHaveLength(1);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
