import { mccodesDialect } from "./dialects/mccodes.js";
import type { DialectId, RunMigrationOptions } from "./dialects/types.js";
import { v2Dialect } from "./dialects/v2.js";
import type { SourceDialect } from "./dialects/types.js";

export type { DialectId, RunMigrationOptions } from "./dialects/types.js";

/**
 * The dialect registry (B1, spec §1 decision 2026-08-26). Selection is an
 * explicit CLI flag, never auto-detection: a wrong guess migrates the wrong
 * game. The planned fourth hybrid dialect `--gl3` joins this record — its
 * `sourceKind` will be the first non-mysql entry, which is why the shared
 * machinery never assumes the source is MySQL.
 */
export const DIALECTS: Record<DialectId, SourceDialect> = {
  v2: v2Dialect,
  mccodes: mccodesDialect,
};

export async function runMigration(
  options: RunMigrationOptions & { dialect?: DialectId },
): Promise<void> {
  await DIALECTS[options.dialect ?? "v2"].run(options);
}
