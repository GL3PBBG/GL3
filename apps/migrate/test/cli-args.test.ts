import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("parses --mysql --pg into a CliArgs", () => {
    const args = parseCliArgs(["--mysql", "mysql://u:p@host/db", "--pg", "postgres://u:p@host/db"]);
    expect(args).toEqual({
      mysqlUrl: "mysql://u:p@host/db",
      pgUrl: "postgres://u:p@host/db",
      dryRun: false,
      reportPath: undefined,
      sqlDumpPath: undefined,
      townCombatMode: "open",
    });
  });

  it("parses --dry-run as a boolean flag with no value", () => {
    const args = parseCliArgs(["--mysql", "mysql://u:p@host/db", "--pg", "postgres://u:p@host/db", "--dry-run"]);
    expect(args.dryRun).toBe(true);
  });

  it("parses --report and --sql-dump", () => {
    const args = parseCliArgs([
      "--pg", "postgres://u:p@host/db",
      "--report", "report.json",
      "--sql-dump", "dump.sql",
    ]);
    expect(args.reportPath).toBe("report.json");
    expect(args.sqlDumpPath).toBe("dump.sql");
    expect(args.mysqlUrl).toBeUndefined();
  });

  it("throws when --pg is missing", () => {
    expect(() => parseCliArgs(["--mysql", "mysql://u:p@host/db"])).toThrow();
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseCliArgs(["--pg"])).toThrow(/--pg requires a value/);
  });

  it("defaults town combat mode to open", () => {
    expect(parseCliArgs(["--pg", "postgres://x"]).townCombatMode).toBe("open");
  });

  it("accepts --town-combat-mode underground", () => {
    expect(parseCliArgs(["--pg", "postgres://x", "--town-combat-mode", "underground"]).townCombatMode)
      .toBe("underground");
  });

  it("rejects a junk town combat mode", () => {
    expect(() => parseCliArgs(["--pg", "postgres://x", "--town-combat-mode", "ghost"])).toThrow();
  });
});
