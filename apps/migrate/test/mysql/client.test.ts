import { describe, expect, it } from "vitest";
import { createIsolatedMysqlFixture } from "../helpers/fixtures.js";
import { createMysqlPool } from "../../src/mysql/client.js";

describe("createMysqlPool", () => {
  it("connects to a utf8-charset V2 database and can query it", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      const [rows] = await pool.query("SELECT U_name FROM users WHERE U_id = 1");
      expect((rows as Array<{ U_name: string }>)[0]?.U_name).toBe("DonVito");
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });
});
