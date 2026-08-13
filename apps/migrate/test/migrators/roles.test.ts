import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { roleModuleAccess, roles } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";

describe("migrateRoles", () => {
  it("migrates userRoles and roleAccess, dropping the orphan role reference", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateRoles(pool, db, report);

      const roleRows = await db.select().from(roles);
      expect(roleRows).toHaveLength(2); // Player, Admin

      const accessRows = await db.select().from(roleModuleAccess);
      expect(accessRows).toHaveLength(2); // role 99 dropped
      expect(accessRows.some((r) => r.moduleKey === "*")).toBe(true);

      const rolesTable = report.tables.find((t) => t.table === "userRoles");
      expect(rolesTable).toEqual({ table: "userRoles", read: 2, written: 2, skipped: 0 });
      const accessTable = report.tables.find((t) => t.table === "roleAccess");
      expect(accessTable).toEqual({ table: "roleAccess", read: 3, written: 2, skipped: 1 });
      expect(report.orphans).toContainEqual({ table: "roleAccess", v2Id: 99, reason: "role 99 does not exist" });

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

      await migrateRoles(pool, db, createReport(false));
      await migrateRoles(pool, db, createReport(false));

      expect(await db.select().from(roles)).toHaveLength(2);
      expect(await db.select().from(roleModuleAccess)).toHaveLength(2);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
