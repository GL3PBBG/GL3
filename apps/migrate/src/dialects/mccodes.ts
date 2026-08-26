import { fingerprintMccodesSchema } from "../mysql/fingerprint-mccodes.js";
import type { RunMigrationOptions, SourceDialect } from "./types.js";

/**
 * The MCCodes v2 dialect (B1 Task 6). The pipeline is intentionally empty
 * this milestone: B1 proves the registry, the fingerprint and the CLI
 * dispatch; the eight phases land with B2–B4 (plan
 * 2026-08-26-mccodes-migrator.md, spec §4), in the V2 dependency order —
 * roles → content → players → gangs → inventory → social → logs → settings.
 */
async function runMccodes(_options: RunMigrationOptions): Promise<void> {
  // Phases land with B2+. Running the dialect today migrates nothing and
  // fails nothing — the report records what the fingerprint already said.
}

export const mccodesDialect: SourceDialect = {
  id: "mccodes",
  label: "MCCodes v2",
  sourceKind: "mysql",
  fingerprint: fingerprintMccodesSchema,
  run: runMccodes,
};
