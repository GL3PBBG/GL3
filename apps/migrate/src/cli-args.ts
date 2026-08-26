import { z } from "zod";

const CliArgsSchema = z.object({
  mysqlUrl: z.string().min(1).optional(),
  pgUrl: z.string().min(1, "--pg is required"),
  dryRun: z.boolean().default(false),
  reportPath: z.string().min(1).optional(),
  sqlDumpPath: z.string().min(1).optional(),
  townCombatMode: z.enum(["open", "underground"]).default("open"),
  /**
   * B1 (spec §1): explicit dialect selection — `--mccodes` selects the
   * MCCodes v2 source, absent stays V2 (backward compatible). The planned
   * `--gl3` hybrid joins the enum when that wave lands; two dialect flags
   * on one command line is an error naming both.
   */
  dialect: z.enum(["v2", "mccodes"]).default("v2"),
});

export type CliArgs = z.infer<typeof CliArgsSchema>;

const FLAG_TO_KEY: Record<string, keyof z.input<typeof CliArgsSchema>> = {
  mysql: "mysqlUrl",
  pg: "pgUrl",
  report: "reportPath",
  "sql-dump": "sqlDumpPath",
  "town-combat-mode": "townCombatMode",
};

/**
 * SPEC §4.1: `gl3-migrate --mysql mysql://... --pg postgres://... [--dry-run]
 * [--report report.json]`, plus `--sql-dump dump.sql` and `--mccodes`. No
 * third-party argv parser — the surface stays small and mostly boolean; a
 * hand-rolled loop keeps the dependency list tight per SPEC §4.1's "keep
 * scope tight".
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const raw: Record<string, string | boolean> = {};
  const dialectFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { raw.dryRun = true; continue; }
    if (arg === "--mccodes") { raw.dialect = "mccodes"; dialectFlags.push("--mccodes"); continue; }
    if (!arg?.startsWith("--")) continue;
    const flag = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${flag} requires a value`);
    const key = FLAG_TO_KEY[flag];
    if (key) raw[key] = value;
  }

  if (dialectFlags.length > 1) {
    throw new Error(`conflicting dialect flags: ${dialectFlags.join(", ")}`);
  }

  return CliArgsSchema.parse(raw);
}
