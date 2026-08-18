#!/usr/bin/env node
import { ZodError } from "zod";
import { parseCliArgs, type CliArgs } from "./cli-args.js";
import { createMysqlPool } from "./mysql/client.js";
import { fingerprintV2Schema } from "./mysql/fingerprint.js";
import { createDb } from "../../server/src/db/client.js";
import { runMigration } from "./orchestrator.js";
import { createReport, finishReport, formatHumanSummary, writeReportFile } from "./report.js";

function dumpModeMessage(sqlDumpPath: string, pgUrl: string): string {
  return [
    "--sql-dump is a convenience flag only: gl3-migrate does not parse SQL dump files directly (SPEC §4.1).",
    "Load the dump into a scratch MySQL/MariaDB instance first, then re-run with --mysql pointing at it:",
    "",
    '  mysql -u root -e "CREATE DATABASE gl3_scratch"',
    `  mysql -u root gl3_scratch < ${sqlDumpPath}`,
    `  gl3-migrate --mysql mysql://root@localhost/gl3_scratch --pg ${pgUrl}`,
  ].join("\n");
}

const USAGE =
  "usage: gl3-migrate --mysql mysql://user:pass@host/v2db --pg postgres://user:pass@host/gl3db " +
  "[--dry-run] [--report report.json] [--town-combat-mode open|underground]";

const KEY_TO_FLAG: Record<string, string> = {
  mysqlUrl: "--mysql",
  pgUrl: "--pg",
  reportPath: "--report",
  sqlDumpPath: "--sql-dump",
  dryRun: "--dry-run",
  townCombatMode: "--town-combat-mode",
};

/** A raw `ZodError.message` is a JSON dump of every issue — unreadable as the
 * first thing an operator sees when they forget a flag. Name the flag instead. */
function formatArgError(err: unknown): string {
  if (!(err instanceof ZodError)) return err instanceof Error ? err.message : String(err);
  return err.issues
    .map((issue) => {
      const flag = KEY_TO_FLAG[String(issue.path[0])] ?? String(issue.path[0]);
      return issue.message === "Required" ? `${flag} is required` : `${flag}: ${issue.message}`;
    })
    .join("\n");
}

/** Exported for tests, which call this directly instead of spawning a
 * subprocess — the guard below only auto-runs it when invoked as a script. */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error(formatArgError(err));
    console.error(USAGE);
    return 1;
  }

  if (args.sqlDumpPath && !args.mysqlUrl) {
    console.error(dumpModeMessage(args.sqlDumpPath, args.pgUrl));
    return 1;
  }
  if (!args.mysqlUrl) {
    console.error("gl3-migrate requires --mysql (or --sql-dump loaded into a scratch MySQL first).");
    return 1;
  }

  const pool = await createMysqlPool(args.mysqlUrl);
  const fingerprint = await fingerprintV2Schema(pool);
  const report = createReport(args.dryRun);
  report.unknownTables = fingerprint.unknownTables;

  if (!fingerprint.ok) {
    console.error(
      `V2 schema fingerprint failed: missing tables [${fingerprint.missingTables.join(", ")}], ` +
      `missing columns ${JSON.stringify(fingerprint.missingColumns)}`,
    );
    await pool.end();
    return 1;
  }

  const { db, sql } = createDb(args.pgUrl);
  try {
    await runMigration({ mysql: pool, db, report, dryRun: args.dryRun, townCombatMode: args.townCombatMode });
  } finally {
    await pool.end();
    await sql.end();
  }

  finishReport(report);
  if (args.reportPath) await writeReportFile(report, args.reportPath);
  console.log(formatHumanSummary(report));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Without this .catch, a rejection from parseCliArgs (zod) or any migrator
  // surfaces as an unhandled rejection with a raw stack trace. Same shape as
  // the gateway bug fixed in 54423c8 — see CLAUDE.md.
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
