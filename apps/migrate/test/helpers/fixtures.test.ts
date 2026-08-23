import mysql from "mysql2/promise";
import { sql as sqlTag } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createIsolatedMysqlFixture } from "./fixtures.js";
import { createIsolatedPgTarget } from "./fixtures.js";
import { createDb } from "../../../server/src/db/client.js";
import { idMap } from "../../../server/src/db/schema/index.js";

describe("createIsolatedMysqlFixture", () => {
  it("loads the V2 schema and seed into a freshly created database", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = mysql.createPool(fixture.url);
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM users");
      expect(rows[0]?.n).toBe(6);
      const [crimeRows] = await pool.query<mysql.RowDataPacket[]>("SELECT C_id FROM crimes ORDER BY C_id");
      expect(crimeRows.map((r) => r.C_id)).toEqual([1, 2, 3, 5, 6, 16]); // the id-4 gap
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("gives two concurrent calls two isolated databases", async () => {
    const [a, b] = await Promise.all([createIsolatedMysqlFixture(), createIsolatedMysqlFixture()]);
    try {
      expect(a.url).not.toBe(b.url);
    } finally {
      await Promise.all([a.teardown(), b.teardown()]);
    }
  });
});

describe("createIsolatedPgTarget", () => {
  it("returns a freshly migrated database with the id_map table present", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const rows = await db.select().from(idMap);
      expect(rows).toEqual([]); // empty, but querying it proves the migration ran
      // The plugin-owned target tables exist too — created by runPluginMigrations,
      // not by apps/server/drizzle ("Known unknowns" item 8). 42P01 here means the
      // plugin half of the helper is missing.
      await db.execute(sqlTag`SELECT 1 FROM p_bounties_bounties LIMIT 1`);
      await db.execute(sqlTag`SELECT 1 FROM p_detectives_searches LIMIT 1`);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });
});
