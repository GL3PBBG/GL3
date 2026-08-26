import { v2Dialect } from "./dialects/v2.js";
import type { RunMigrationOptions } from "./dialects/types.js";

export type { RunMigrationOptions } from "./dialects/types.js";

/**
 * Thin delegate (B1 Task 5): the V2 pipeline now lives in `dialects/v2.ts`,
 * moved verbatim — same phase order, same guards, same migrators. The
 * dialect registry and the `--mccodes` flag land with Task 6; until then
 * every caller (the CLI and the test suite) runs exactly the code that used
 * to live here, which is the extraction's acceptance test.
 */
export async function runMigration(options: RunMigrationOptions): Promise<void> {
  await v2Dialect.run(options);
}
