/**
 * Plugin migrations, applied in order at boot by the engine's plugin runner.
 *
 * - ONE statement per entry. The runner executes each `sql` as a single
 *   statement; a `;`-joined pair silently applies only the first.
 * - `name` is unique forever. Applied names are recorded; renaming one
 *   re-applies it on the next boot.
 * - Every table is `p___ID___<name>`, declared in `tables` on the manifest.
 * - A foreign key is a lock (rule 6). An FK to `players` is safe; one to
 *   `locations` is not — bullets, theft, properties and casino FOR UPDATE it.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [];
