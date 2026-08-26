import mysql from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createMysqlPool } from "../../src/mysql/client.js";
import { fingerprintMccodesSchema } from "../../src/mysql/fingerprint-mccodes.js";
import { main } from "../../src/cli.js";

/**
 * B1 Task 6: the MCCodes fingerprint and the CLI dispatch. The wrong-dialect
 * mistake is the one this milestone exists to make loud — `--mccodes` at a
 * V2 database must fail the preflight naming the MCCodes columns V2 lacks,
 * before a single row moves.
 */

/** The three REQUIRED tables with exactly their required columns. */
const MCCODES_MINIMUM = [
  "CREATE TABLE users (userid int(11), username varchar(20), userpass varchar(60))",
  "CREATE TABLE userstats (userid int(11), strength float)",
  "CREATE TABLE settings (conf_id int(11), conf_name varchar(50), conf_value text)",
];

describe("fingerprintMccodesSchema", () => {
  it("passes on the three required tables and reports unknown tables", async () => {
    const fixture = await createIsolatedMysqlFixture({ files: [] });
    try {
      const conn = await mysql.createConnection({ uri: fixture.url, multipleStatements: true });
      await conn.query(MCCODES_MINIMUM.join(";"));
      await conn.query("CREATE TABLE myMod_stuff (id int(11))");
      await conn.end();

      const pool = await createMysqlPool(fixture.url);
      const result = await fingerprintMccodesSchema(pool);
      expect(result.ok).toBe(true);
      expect(result.missingTables).toEqual([]);
      expect(result.missingColumns).toEqual({});
      // Third-party module tables report unknown, exactly as V2's do.
      expect(result.unknownTables).toEqual(["myMod_stuff"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("fails when a required column is absent from a present table", async () => {
    const fixture = await createIsolatedMysqlFixture({ files: [] });
    try {
      const conn = await mysql.createConnection({ uri: fixture.url, multipleStatements: true });
      // users without userpass — an install too old or too mangled to read.
      await conn.query(MCCODES_MINIMUM.slice(1).join(";"));
      await conn.query("CREATE TABLE users (userid int(11), username varchar(20))");
      await conn.end();

      const pool = await createMysqlPool(fixture.url);
      const result = await fingerprintMccodesSchema(pool);
      expect(result.ok).toBe(false);
      expect(result.missingColumns).toMatchObject({ users: ["userpass"] });
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });
});

describe("--mccodes CLI dispatch", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { errorSpy.mockRestore(); logSpy.mockRestore(); });

  it("refuses a V2 database: the MCCodes fingerprint names the columns V2 lacks", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const code = await main(["--mccodes", "--mysql", fixture.url, "--pg", target.url]);
      expect(code).toBe(1);
      const message = errorSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain("MCCodes v2 schema fingerprint failed");
      // `userid` is the tell: V2's users table carries U_id instead.
      expect(message).toContain("userid");
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("runs the (still empty) pipeline against an MCCodes-shaped source and exits 0", async () => {
    const fixture = await createIsolatedMysqlFixture({ files: [] });
    const target = await createIsolatedPgTarget();
    try {
      const conn = await mysql.createConnection({ uri: fixture.url, multipleStatements: true });
      await conn.query(MCCODES_MINIMUM.join(";"));
      await conn.end();

      const code = await main(["--mccodes", "--mysql", fixture.url, "--pg", target.url]);
      // B1: the registry dispatch and fingerprint are proven; the eight
      // phases land with B2-B4, so a green run migrates nothing yet.
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
