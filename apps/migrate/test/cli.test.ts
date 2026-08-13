import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { main } from "../src/cli.js";

describe("main (CLI entrypoint)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { errorSpy.mockRestore(); logSpy.mockRestore(); });

  it("runs the full migration and writes the report file", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const dir = await mkdtemp(join(tmpdir(), "gl3-migrate-cli-"));
      const reportPath = join(dir, "report.json");

      const code = await main(["--mysql", fixture.url, "--pg", target.url, "--report", reportPath]);

      expect(code).toBe(0);
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report.tables.find((t: { table: string }) => t.table === "users")).toMatchObject({ written: 6 });
      expect(report.unknownTables.sort()).toEqual(["blackjackHands", "premiumMembership"]);
      expect(logSpy).toHaveBeenCalled(); // human summary printed
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("prints the scratch-MySQL instructions and exits 1 for --sql-dump without --mysql", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const code = await main(["--sql-dump", "dump.sql", "--pg", target.url]);
      expect(code).toBe(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("scratch MySQL");
    } finally {
      await target.teardown();
    }
  });

  it("fails preflight and exits 1 when a required table is missing, without touching Postgres", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      await pool.query("DROP TABLE userTimers");
      await pool.end();

      const code = await main(["--mysql", fixture.url, "--pg", target.url]);
      expect(code).toBe(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("fingerprint failed");
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("--dry-run reports success but leaves the target database empty", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const code = await main(["--mysql", fixture.url, "--pg", target.url, "--dry-run"]);
      expect(code).toBe(0);
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
