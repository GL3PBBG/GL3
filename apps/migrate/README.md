# @gl3/migrate

`gl3-migrate` converts a live Gangster Legends V2 MySQL database into a GL3 PostgreSQL
database. Players keep their accounts (passwords are lazy-rehashed on first login —
see SPEC §4.3), cash, gangs, and inventories.

## Building

```bash
npm run build --workspace @gl3/migrate
```

`tsc --build` typechecks and emits, then esbuild bundles `src/cli.ts` into the single
`dist/cli.js` the `gl3-migrate` bin points at. The bundle step is not cosmetic: this
package imports the server's drizzle schema and db client across a TypeScript project
boundary (`../../server/src/...`), and `tsc` copies those specifiers into its output
verbatim rather than rewriting them at `apps/server/dist`, so the plain `tsc` output
dies at load with `ERR_MODULE_NOT_FOUND`. Runtime dependencies (`mysql2`, `postgres`,
`drizzle-orm`, the plugin packages) stay external and resolve from `node_modules` as
usual.

Without a build, run it straight from source with `npm start --workspace @gl3/migrate --
--mysql ... --pg ...` (tsx).

## Preparing the target

`gl3-migrate` writes into an existing GL3 schema; it does not create one. Two of its
target tables (`p_bounties_bounties`, `p_detectives_searches`) are plugin-owned and
are created by plugin migrations at server boot, not by `db:migrate`. So, against a
fresh database:

```bash
cd apps/server
DATABASE_URL=postgres://user:pass@host/gl3db npm run db:migrate   # core tables
DATABASE_URL=... npm start   # boot once so loadPlugins runs the plugin migrations, then stop it
```

## Usage

```bash
gl3-migrate --mysql mysql://user:pass@host/v2db --pg postgres://user:pass@host/gl3db
```

Flags:

- `--dry-run` — run every migrator for real, inside a transaction that is always
  rolled back. Nothing is written. Use this first against a production V2 database.
- `--report report.json` — write the full machine-readable report (per-table
  read/written/skipped counts, orphan rows, unknown tables, unknown `userTimers`
  keys, dropped `US_crimes` positions, duration) alongside the human summary
  printed to stdout.
- `--sql-dump dump.sql` — **not a direct import.** `gl3-migrate` does not parse SQL
  dump files (SPEC §4.1 explicitly scopes this out). Passing this flag without
  `--mysql` prints the two commands to load the dump into a scratch MySQL/MariaDB
  instance and re-run against that instead.

## Re-running

The whole run is idempotent. Every V2 auto-increment id is resolved to a stable GL3
UUIDv7 through an `id_map(v2_table, v2_id) -> v3_id` table maintained by the migrator
itself — re-running against the same source database updates existing GL3 rows in
place rather than duplicating them. This is safe to do repeatedly, including after
players have started logging in and having their passwords upgraded to argon2id
(the migrator never re-locks an already-upgraded password back to legacy auth).

## Orphan and unknown-data policy

V2 has no foreign keys. Real dumps contain rows referencing deleted users, gangs, or
items. The migrator never crashes on this — an orphaned row is skipped and recorded
in the report under `orphans`. Tables the migrator doesn't recognize (a custom
module's tables, or a core V2 table with no GL3 counterpart in v1, like
`premiumMembership` or the forum tables) are listed under `unknownTables` — "custom
module tables, not migrated." Nothing here is fatal; check the report afterward.

## Framework-shaped sources and targets (openPBBG)

An openPBBG database is GL2's framework without the gangster game: the account
tables are byte-identical, the game tables (`crimes`, `gangs`, `cars`, ...) and
userStats' two game columns (`US_gang`, `US_crimes`) simply do not exist. The
fingerprint requires only the account tables; every games phase whose source
tables are absent skips and is listed under `missingSourceTables`. Symmetrically,
a `GL3_PROFILE=framework` target never created the gameplay plugins' `p_*`
tables — migrators headed for one skip that section and record it under
`absentTargetTables`. Both fields are informational: accounts, mail, news,
settings, items and membership packages migrate normally either way.

## Model differences from V2 (deliberate, see SPEC §2.5)

- `users` + `userStats` merge into `players` + `player_stats` (kept as two tables
  for hot-row separation).
- `US_gang` (an int column) becomes the `gang_members` join table.
- `US_crimes` (a dash-delimited string indexed by `C_id - 1`) explodes into
  `player_crime_skill` rows.
- Item EAV tables (`itemEffects`, `itemMeta`) merge into `items.effects` /
  `items.meta` JSONB columns.
- `transactions` (the ledger) has no per-transaction *history* to backfill — V2 keeps
  only current balances. But the ledger cannot start empty: SPEC §2.3 requires every
  balance to be explained by an append-only ledger insert (`sum(ledger) == balance`).
  So the players migrator seeds one `reason = "migration.opening_balance"` row per
  migrated player, per non-zero balance kind (cash/bank/points); zero balances get no
  row (`sum(∅) = 0` already satisfies the invariant). `crime_log` is not migrated —
  V2 keeps no history.
- Forum tables, `premiumMembership`, and casino/blackmarket-style custom module
  tables have no GL3 schema in v1 (SPEC §5) and are reported, not migrated.
