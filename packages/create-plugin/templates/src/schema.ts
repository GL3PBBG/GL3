/**
 * Drizzle tables.
 *
 * - Your own tables: `p___ID_SNAKE___*`, created by src/migrations.ts and declared
 *   under `tables` on the manifest. Define them here with `pgTable`.
 * - Core tables you READ: declare a read-only mirror here with only the
 *   columns you use (e.g. `players.id`, `player_stats.location_id`). Never
 *   migrate a core table from a plugin.
 *
 * The bigint columns are `bigint({ mode: "bigint" })` — money is bigint end
 * to end and crosses the wire as a decimal string.
 */
export {};
