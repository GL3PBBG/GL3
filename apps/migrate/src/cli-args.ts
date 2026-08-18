import { z } from "zod";

const CliArgsSchema = z.object({
  mysqlUrl: z.string().min(1).optional(),
  pgUrl: z.string().min(1, "--pg is required"),
  dryRun: z.boolean().default(false),
  reportPath: z.string().min(1).optional(),
  sqlDumpPath: z.string().min(1).optional(),
  townCombatMode: z.enum(["open", "underground"]).default("open"),
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
 * [--report report.json]`, plus `--sql-dump dump.sql`. No third-party argv
 * parser — the surface is six flags, one of them boolean; a hand-rolled
 * loop keeps the dependency list tight per SPEC §4.1's "keep scope tight".
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const raw: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { raw.dryRun = true; continue; }
    if (!arg?.startsWith("--")) continue;
    const flag = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${flag} requires a value`);
    const key = FLAG_TO_KEY[flag];
    if (key) raw[key] = value;
  }

  return CliArgsSchema.parse(raw);
}
