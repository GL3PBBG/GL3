import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { createIsolatedMysqlFixture } from "./fixtures.js";

describe("createIsolatedMysqlFixture", () => {
  it("loads the V2 schema and seed into a freshly created database", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = mysql.createPool(fixture.url);
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM users");
      expect(rows[0]?.n).toBe(6);
      const [crimeRows] = await pool.query<mysql.RowDataPacket[]>("SELECT C_id FROM crimes ORDER BY C_id");
      expect(crimeRows.map((r) => r.C_id)).toEqual([1, 2, 3, 5, 6]); // the id-4 gap
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
