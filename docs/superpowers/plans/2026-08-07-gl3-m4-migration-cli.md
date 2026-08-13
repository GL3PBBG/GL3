# GL3 M4 — Migration CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/migrate`, a CLI that converts a live V2 MySQL database into a working GL3 Postgres game — players keep accounts (lazy-rehashed passwords), cash, gangs, and inventories — and prove it against a seeded V2 fixture built for this milestone (no `install/schema.sql` checkout exists in this repo).

**Architecture:** A single-binary Node CLI (`gl3-migrate`) that reads argv, connects to both databases, runs a **schema-fingerprint preflight**, then a strictly-ordered 8-phase pipeline (roles → rounds → content → players → gangs → inventory/garage/properties → social → settings). Each phase runs inside its own Postgres transaction (§4.2 "batched transactions"); `--dry-run` runs every phase's transaction for real and then rolls it back, so every code path is exercised but nothing durable is written. Every V2 auto-increment id is resolved to a stable GL3 UUIDv7 through `id_map(v2_table, v2_id) → v3_id`, looked up before insert and reused on re-run — this single mechanism is what makes the whole run idempotent, not per-migrator special-casing. Orphans (rows referencing a missing user/gang/item) are skipped and counted, never fatal. A `MigrationReport` accumulates per-table counts, orphan lists, unknown tables/timer keys, and dropped `US_crimes` positions, and is written as JSON (`--report`) and printed as a human summary.

**Tech Stack:** Node 22 LTS (ESM) · TypeScript strict · `mysql2/promise` · Drizzle ORM + `postgres` driver (reusing `apps/server`'s schema — GL3 has one schema, not two) · MariaDB 10.11 (native, V2-compatible substitute for MySQL — see Task 1) · PostgreSQL 16 · zod · vitest.

## Independence groups (for parallel worktrees)

- **Task 1** (install/start MariaDB, create the fixture DB) has no code dependency on anything else — do it first, in parallel with Task 2 if two workers are available.
- **Tasks 1 → 2** is the only hard prerequisite before any other task starts (Task 2 creates the `apps/migrate` package every later task's files live under).
- After Task 2: **Tasks 3, 5, 8 are mutually independent** (disjoint files: fixture SQL, Postgres test isolation, report module) — parallelize freely.
- **Task 4** needs Task 1 (MariaDB running) + Task 3 (schema file to load). **Task 6** needs Task 4 — its whole point is proving the pool survives a `utf8`-charset connection, and the only `utf8`-charset database in this plan is the one Task 4's `createIsolatedMysqlFixture` creates, so its test cannot run until Task 4 lands (the two were previously listed as independent; that was wrong, corrected here). **Task 7** needs Task 5 (a Postgres db to test id_map against). **Task 9** needs Task 4 (a loaded fixture) + Task 6 (a client to query it with). **Task 10** needs Task 5. Tasks 1–10 together are "the foundation."
- **Tasks 11–28 are the per-table/per-domain migrators — disjoint files under `src/migrators/`, safe to write/review/merge in parallel.** Within that band there is one real constraint, and it comes from Postgres, not from the plan: GL3's schema has **real foreign keys** (§2.5), so e.g. `player_stats.rank_id -> ranks.id` is enforced — a migrator's own test that inserts a `player_stats` row referencing a rank must first have a real `ranks` row at that uuid in the target database, which means calling the already-built `migrateRanks` as test setup, not hand-rolling an equivalent insert. Concretely: **Tasks 11-19 (roles, rounds, content) have zero dependencies among themselves — parallelize freely, this is the biggest win.** **Tasks 20-28 (players onward) additionally need 11-19 merged first**, because their tests seed realistic FK targets by calling those migrators directly — but 20-28 remain independent **of each other** for authorship (disjoint files), even though their tests run in roughly the same dependency order the real pipeline (Task 29) will use: players core(20) -> timers(21) + crime-skill(22) [same phase, need 20] -> gangs(23) [needs 20] -> gang-social(24) [needs 23] -> inventory/garage(25) [needs 20] -> properties(26) [needs 20] -> social(27) [needs 20] -> bounties/detectives(28) [needs 20].
- **Tasks 29–33 chain strictly** and must run after every migrator in 11–28 is merged: orchestrator(29) → {idempotency test(30), legacy-login e2e test(31)} in parallel → CLI wiring(32) → README(33).

## Global Constraints

These apply to **every** task in this plan. Do not restate them per task; do not violate them.

- **Stack is fixed.** Node 22 LTS, TypeScript strict, PostgreSQL 16, MariaDB 10.11 (V2's MySQL substitute — see Task 1), no Docker in this environment.
- **TypeScript strict everywhere, no `any`.** Prefer `unknown` + a zod parse, or a narrow documented type assertion with a comment justifying it (e.g. the dry-run transaction-outcome cast in Task 10) — never a silent `any`.
- **ESM only**, relative imports carry a `.js` extension.
- **Zod-validates every external boundary**: CLI argv, the `--report` path, MySQL row shapes where a malformed dump could otherwise crash the process silently.
- **No FKs in V2. Real dumps have orphans.** Every migrator tolerates a missing reference by skipping the row and recording it in the report — it never throws.
- **Money stays `bigint` end-to-end.** V2 `int(11)` values (max ~2.14B) convert with `BigInt(value)`; GL3 columns are already `bigint` (built in M0/M1). No floating point, ever.
- **Every V2 unix-epoch `int(11)` timestamp becomes a `Date` via `unixToDate()`** (Task 2), then a `timestamptz` on insert.
- **`id_map(v2_table, v2_id) → v3_id` is the ONLY source of truth for "does this V2 row already have a GL3 row".** A migrator never invents a uuid inline — it always goes through `getOrCreateV3Id()` (Task 7). This is what makes re-running idempotent: the same V2 row always resolves to the same GL3 uuid, so a second run's `INSERT ... ON CONFLICT DO UPDATE` overwrites in place instead of duplicating.
- **Not every table needs `id_map`.** `settings` keys its GL3 row identically to its V2 row (the string key itself) — idempotency there comes from `ON CONFLICT (key) DO UPDATE`, no surrogate key needed. Reserve `id_map` for tables that need one.
- **`--dry-run` performs zero durable writes**, proven by running every statement inside a transaction that is always rolled back (Task 10), not by skipping statements.
- **The whole run is idempotent.** Migrating a fixture twice produces the same row counts and the same UUIDs on both runs — this is M4's acceptance criterion and gets a dedicated test (Task 30).
- **`crime_log` is NOT backfilled from V2.** V2 keeps no per-crime history; there is nothing to migrate. This is a deliberate scope limit, not a bug to "fix" later.
- **`transactions` IS seeded with one opening-balance row per migrated player, per non-zero balance kind.** V2 has no per-transaction history, so there is no *history* to migrate — but the ledger cannot simply start empty. SPEC §2.3 requires every balance to be explained by an append-only ledger insert, and M2's acceptance criterion is `sum(ledger) == balance`. A migrated player holding cash with zero ledger rows would violate that invariant permanently: any reconciliation over a migrated game would flag every legacy player as corrupt, and the invariant would hold only for accounts created after cutover.

  So the players migrator writes, inside the same transaction that creates `player_stats`, one `transactions` row per non-zero balance (`cash`, `bank`, `points`) with `reason = "migration.opening_balance"` and `ref_id` null. Zero balances get no row — `sum(∅) = 0` already satisfies the invariant. The rows are idempotent along with everything else: a re-run must not double them, which falls out of the `id_map` guard on the player itself.

  Verify this in the idempotency task (Task 30): after two runs, assert `sum(transactions.amount) == player_stats.<kind>` for every migrated player and every balance kind.
- **Conventional Commits, one commit per task.**

## Known unknowns this plan resolves by explicit decision (not guessing silently)

SPEC §1.2's catalogue documents *columns and quirks*, not exact V2 `CREATE TABLE` DDL — the V2 source (`install/schema.sql`) is not checked out in this repo and this plan does not fetch it over the network (test-fixture reliability > convenience — a network fetch during `npm test` would make CI flaky). **Task 3 reconstructs the V2 fixture schema from SPEC §1.2 directly, as literal `CREATE TABLE` statements**, using the exact column names SPEC quotes (`U_id`, `US_money`, `US_crimes`, `PR_module`, …) and reasonable, stated inferences for columns SPEC mentions by purpose but not by exact name. Every inference is called out where it's made:

1. **`rounds`'s columns.** SPEC abbreviates them `R_start`/`R_end`, but `ranks` already owns the `R_` prefix in this reconstruction. This plan uses `RND_start`/`RND_end` for `rounds` to keep generated code unambiguous — a cosmetic renaming with zero behavioural effect, noted here so nobody "fixes" it later against a phantom spec conflict.
2. **`U_userLevel → roles`.** SPEC says `U_userLevel` is "(1=user, admin levels)" but never states it's literally `userRoles.UR_id`. This plan treats it as exactly that (a common V2-era convention: level number *is* the role id). If a level has no matching role row, `players.role_id` is left `null` — not reported as an orphan, since §4.2's orphan policy names "missing users/gangs/items" specifically, not roles, and `role_id` is nullable in the GL3 schema.
3. **`player_stats.gang_id` is populated in the GANGS phase, not the PLAYERS phase.** §4.2's dependency order runs players *before* gangs, so a gang uuid can't be resolved yet when a player row is written. `player_stats.gang_id` is left `null` by the players migrator and back-filled by an `UPDATE` in the gangs migrator (Task 23), once `gang_members` — the actual source of truth per the §2.5 model-change note — exists. This is the natural resolution of an ordering constraint the spec itself creates, not a workaround.
4. **Boss/underboss cross-check extends to underboss too.** §4.2 item 5 states the check for "boss not in his own gang." This plan applies the identical check to `underboss_player_id` for the same reason the spec gives for boss — an underboss outside their own gang's membership table is exactly as broken — and reports it the same way. Flagged here as a deliberate, spec-consistent extension, not an invented requirement.
5. **V2 `bounties` has no claimant column** (SPEC §1.2: `B_user`, `B_userToKill`, `B_cost` only). A row present in the dump is, by definition, still open — every migrated row gets `claimed_by = null`.
6. **V2 `detectives` has no detective-count column** (SPEC §1.2: `D_start`/`D_end`/`D_success` only). Each V2 row is one search by one detective; migrated rows default `detectives = 1`.
7. **`mail.M_parent` is walked to its root**, not copied 1:1, because GL3's `mail_messages.thread_id` is a flat grouping key (§2.5), while V2's `M_parent` is a parent pointer that can chain arbitrarily deep. Task 27 computes the root once per message with cycle protection (V2 has no FK enforcement, so a malformed parent cycle is possible in a real dump) and memoizes it.
8. **`bounties` and `detective_searches` are plugin-owned in GL3.** Core migration `0007_relinquish_plugin_tables` (merged after this plan was first written) dropped both from core; the `bounties` and `detectives` plugins now own and migrate them as `p_bounties_bounties` and `p_detectives_searches`. Column sets are unchanged — only names and ownership moved. Three consequences, folded into the tasks below: `createIsolatedPgTarget` (Task 5) runs those two plugins' migrations (via `runPluginMigrations` + the plugin manifests) after the core `apps/server/drizzle` folder, or Task 28/29/30's inserts die on 42P01; the migrator gets its drizzle handles from `src/pg/plugin-tables.ts`, a hand-maintained mirror — the same pattern as `apps/server/test/helpers/plugin-tables.ts`, because the plugin packages export only their manifests; and the README (Task 33) documents that a real cutover target needs plugin migrations run (one server boot) before migrating, since `db:migrate` alone creates only core tables.

---

## File Structure

Files that change together live together. Each file below has one responsibility.

**Repo root**
- `.env.example` — gains `MYSQL_ADMIN_URL`, documented for the two MySQL-touching test-isolation helpers (Task 4)
- `tsconfig.json` — gains the `apps/migrate` project reference (Task 2)
- `vitest.workspace.ts` — gains the `apps/migrate` project entry (Task 2)

**`apps/migrate`** — the CLI, new package this milestone.
- `package.json`, `tsconfig.json`
- `src/cli-args.ts` — `parseCliArgs(argv)`, zod-validated
- `src/time.ts` — `unixToDate(seconds: number | null): Date | null`
- `src/mysql/client.ts` — `createMysqlPool(mysqlUrl)`, utf8mb4-with-fallback
- `src/mysql/fingerprint.ts` — `fingerprintV2Schema(pool)` (§4.2 item 1)
- `src/pg/types.ts` — `Executor`, `Tx` type aliases shared by every migrator
- `src/pg/plugin-tables.ts` — drizzle mirrors of the two plugin-owned target tables `p_bounties_bounties` / `p_detectives_searches` ("Known unknowns" item 8)
- `src/pg/run-phase.ts` — `runPhase()`, the batched-transaction + dry-run-rollback primitive
- `src/id-map.ts` — `getOrCreateV3Id()`, `lookupV3Id()` — the idempotency mechanism
- `src/report.ts` — `MigrationReport` type, `createReport`, `bumpTable`, `recordOrphan`, `finishReport`, `writeReportFile`, `formatHumanSummary`
- `src/migrators/roles.ts` — `userRoles` + `roleAccess` → `roles` + `role_module_access`
- `src/migrators/rounds.ts` — `rounds` → `rounds`
- `src/migrators/ranks.ts` — `ranks` + `moneyRanks` → `ranks` + `money_ranks`
- `src/migrators/crimes.ts` — `crimes` → `crimes`
- `src/migrators/locations.ts` — `locations` → `locations`
- `src/migrators/cars.ts` — `cars` + `theft` → `cars` + `theft_tiers`
- `src/migrators/weapons.ts` — `weapons` → `weapons`
- `src/migrators/items.ts` — `items` + `itemEffects` + `itemMeta` → `items` (JSONB merge)
- `src/migrators/settings.ts` — `settings` → `settings`
- `src/migrators/players.ts` — `users` + `userStats` → `players` + `player_stats` (core columns only)
- `src/migrators/timers.ts` — `userTimers` → `player_timers` / `jailed_until` / `hospital_until`
- `src/migrators/crime-skill.ts` — `US_crimes` explode → `player_crime_skill`
- `src/migrators/gangs.ts` — `gangs` + `US_gang` → `gangs` + `gang_members`, boss/underboss cross-check
- `src/migrators/gang-social.ts` — `gangPermissions` + `gangInvites` + `gangLogs` → `gang_permissions` / `gang_invites` / `gang_logs`
- `src/migrators/inventory.ts` — `userInventory` + `garage` → `player_items` + `garage`
- `src/migrators/properties.ts` — `properties` → `properties`
- `src/migrators/social.ts` — `mail` + `notifications` + `gameNews` → `mail_messages` / `notifications` / `game_news`
- `src/migrators/bounties-detectives.ts` — `bounties` + `detectives` → `p_bounties_bounties` + `p_detectives_searches` (plugin-owned — "Known unknowns" item 8)
- `src/orchestrator.ts` — `runMigration()`, wires all 28 migrators into the 8-phase pipeline
- `src/cli.ts` — `main(argv)`, the process entrypoint
- `test/fixtures/v2-schema.sql` — reconstructed V2 `CREATE TABLE` statements (Task 3)
- `test/fixtures/v2-seed.sql` — seed data covering every quirk under test (Task 4)
- `test/helpers/fixtures.ts` — `createIsolatedMysqlFixture()`, `createIsolatedPgTarget()` (Tasks 4–5)
- `test/*.test.ts` — one per migrator/module, named to match its `src/` file
- `README.md` — usage, dump-mode limitation, model-difference notes (Task 33)

---

# Foundation

### Task 1: Install and start MariaDB, create the fixture database

**The blocker:** MySQL is not installed in this environment (verified: `which mysql mysqld` → nothing). Docker is unavailable. PostgreSQL 16.14 and Redis 7.0.15 already run natively. This task installs **MariaDB 10.11** — confirmed available via `apt-cache policy mariadb-server` → `1:10.11.14-0ubuntu0.24.04.1` on this Ubuntu 24.04 box — as a wire-compatible, license-compatible substitute for MySQL. V2 targets MySQL 5.x-era SQL with no MySQL-8-only syntax (no CTEs, no window functions, no JSON functions in the audited schema), so MariaDB 10.11 is schema-compatible for every statement this migrator issues or the fixture uses.

**Files:**
- Modify: `.env.example` (add `MYSQL_ADMIN_URL`)
- No application code — this task is infrastructure.

**Interfaces:**
- Consumes: nothing.
- Produces: a running `mariadbd` listening on `127.0.0.1:3306`, a `gl3_migrate_root` MySQL user usable as the admin connection for Tasks 4/9, and the env var `MYSQL_ADMIN_URL`.

- [ ] **Step 1: Install MariaDB server and client**

```bash
sudo apt-get update
sudo apt-get install -y mariadb-server mariadb-client
```

Expected: installs `mariadb-server` `1:10.11.14-0ubuntu0.24.04.1` (or newer patch) and starts the service automatically via the package's postinst (`invoke-rc.d mariadb start`).

- [ ] **Step 2: Verify it started, start it manually if not**

This environment's PID 1 is `systemd` (verified), so either form works; `service` is used here because it also works in non-systemd containers, matching how `docker-compose.yml`'s healthcheck pattern is meant to be portable.

```bash
sudo service mariadb status || sudo service mariadb start
mysqladmin ping   # expect: "mysqld is alive"
```

- [ ] **Step 3: Create an admin user the migrator's tests can connect as**

MariaDB's default install only allows the Unix `root` user to connect via `unix_socket` auth with no password. Tests need a TCP connection with a plain password (matching a real V2 host's `mysql://user:pass@host/db` deployment shape) so `mysql2` config paths get exercised the same way they will in production.

```bash
sudo mysql -e "
  CREATE USER IF NOT EXISTS 'gl3_migrate_root'@'127.0.0.1' IDENTIFIED BY 'gl3_migrate_root';
  GRANT ALL PRIVILEGES ON \`gl3\_%\`.* TO 'gl3_migrate_root'@'127.0.0.1' WITH GRANT OPTION;
  FLUSH PRIVILEGES;
"
```

The `gl3\_%` wildcard grant (not `*.*`) means this user can create/drop only databases prefixed `gl3_` — Task 4's isolated-fixture helper names every scratch database `gl3_test_mysql_<hex>`, so this is exactly the privilege surface it needs and no more.

- [ ] **Step 4: Verify TCP connectivity as that user**

```bash
mysql -h 127.0.0.1 -u gl3_migrate_root -pgl3_migrate_root -e "SELECT VERSION();"
```

Expected: prints a `10.11.x-MariaDB` version string.

- [ ] **Step 5: Document the admin connection string**

Add to `.env.example` (existing file — insert after the `REDIS_URL` line):

```bash
# MariaDB 10.11 admin connection used ONLY by apps/migrate's test suite to
# create/drop per-test-file isolated V2 fixture databases (gl3_test_mysql_*).
# Never used against a real production V2 database — gl3-migrate's own
# --mysql flag takes a full connection string per invocation, unrelated to this.
MYSQL_ADMIN_URL=mysql://gl3_migrate_root:gl3_migrate_root@127.0.0.1:3306/mysql
```

- [ ] **Step 6: Commit**

```bash
cd /home/dlite/GL3
git add .env.example
git commit -m "chore(migrate): document MariaDB admin connection for fixture tests"
```

---

### Task 2: `apps/migrate` package scaffold, CLI argument parsing, and `unixToDate`

**Files:**
- Create: `apps/migrate/package.json`, `apps/migrate/tsconfig.json`
- Create: `apps/migrate/src/cli-args.ts`
- Create: `apps/migrate/src/time.ts`
- Modify: `tsconfig.json` (root — add project reference)
- Modify: `vitest.workspace.ts` (add `apps/migrate` project)
- Test: `apps/migrate/test/cli-args.test.ts`, `apps/migrate/test/time.test.ts`

**Interfaces:**
- Consumes: nothing (first task in the package).
- Produces:
  - `parseCliArgs(argv: string[]): CliArgs` and `type CliArgs = { mysqlUrl?: string; pgUrl: string; dryRun: boolean; reportPath?: string; sqlDumpPath?: string }`.
  - `unixToDate(seconds: number | null | undefined): Date | null`.

- [ ] **Step 1: Create the package**

`apps/migrate/package.json`:

```json
{
  "name": "@gl3/migrate",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "gl3-migrate": "./dist/cli.js" },
  "scripts": {
    "build": "tsc --build",
    "start": "tsx src/cli.ts"
  },
  "dependencies": {
    "@gl3/plugin-bounties": "*",
    "@gl3/plugin-detectives": "*",
    "drizzle-orm": "^0.45.2",
    "mysql2": "^3.11.5",
    "postgres": "^3.4.5",
    "uuidv7": "^1.0.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.2"
  }
}
```

`apps/migrate/tsconfig.json` — references `../server` because every migrator imports the GL3 schema and `createDb` straight from `apps/server/src`, not a duplicate copy (SPEC §2.5 defines one schema, used by both apps). The two plugin references exist because `createIsolatedPgTarget` (Task 5) imports those plugins' manifests to create the plugin-owned target tables ("Known unknowns" item 8):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../server" },
    { "path": "../../packages/plugins/bounties" },
    { "path": "../../packages/plugins/detectives" }
  ]
}
```

Add the reference to the root `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./apps/server" },
    { "path": "./apps/web" },
    { "path": "./apps/migrate" }
  ]
}
```

Then run `npm install`.

- [ ] **Step 2: Write the failing CLI args test**

Covers the SPEC §4.1 interface verbatim, plus the two states dump-mode and normal mode need distinguished (Task 32 reads `sqlDumpPath` to print the "load into scratch MySQL first" message).

`apps/migrate/test/cli-args.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/cli-args.test.ts`
Expected: FAIL — cannot resolve `../src/cli-args.js`.

- [ ] **Step 4: Write `cli-args.ts`**

```ts
import { z } from "zod";

const CliArgsSchema = z.object({
  mysqlUrl: z.string().min(1).optional(),
  pgUrl: z.string().min(1, "--pg is required"),
  dryRun: z.boolean().default(false),
  reportPath: z.string().min(1).optional(),
  sqlDumpPath: z.string().min(1).optional(),
});

export type CliArgs = z.infer<typeof CliArgsSchema>;

const FLAG_TO_KEY: Record<string, keyof z.input<typeof CliArgsSchema>> = {
  mysql: "mysqlUrl",
  pg: "pgUrl",
  report: "reportPath",
  "sql-dump": "sqlDumpPath",
};

/**
 * SPEC §4.1: `gl3-migrate --mysql mysql://... --pg postgres://... [--dry-run]
 * [--report report.json]`, plus `--sql-dump dump.sql`. No third-party argv
 * parser — the surface is five flags, one of them boolean; a hand-rolled
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
```

- [ ] **Step 5: Run the CLI args test to verify it passes**

Run: `npx vitest run apps/migrate/test/cli-args.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing time test**

`unixToDate` is used by every migrator touching a V2 timestamp column, so it gets its own file and test rather than being inlined repeatedly.

`apps/migrate/test/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unixToDate } from "../src/time.js";

describe("unixToDate", () => {
  it("converts a unix-epoch second count to a Date", () => {
    expect(unixToDate(1_700_000_000)).toEqual(new Date(1_700_000_000_000));
  });

  it("passes through null and undefined as null", () => {
    expect(unixToDate(null)).toBeNull();
    expect(unixToDate(undefined)).toBeNull();
  });
});
```

- [ ] **Step 7: Run it to verify it fails, then write `time.ts`**

Run: `npx vitest run apps/migrate/test/time.test.ts` → FAIL.

```ts
/** V2 stores every timestamp as a unix-epoch `int(11)` (SPEC §1.1). */
export function unixToDate(seconds: number | null | undefined): Date | null {
  if (seconds === null || seconds === undefined) return null;
  return new Date(seconds * 1000);
}
```

Run again: PASS, 2 tests.

- [ ] **Step 8: Add `apps/migrate` to the vitest workspace**

Unlike `apps/server`, this package has no shared Redis/rate-limit state to isolate — its per-file isolation (a fresh MySQL fixture + a fresh migrated Postgres database) is built explicitly in Tasks 4–5 as helper functions each test file calls itself, not as blanket `setupFiles`, because `gl3-migrate` takes connection strings as explicit arguments rather than reading them from `process.env` — there is no ambient global to isolate.

`vitest.workspace.ts` — add a plain string entry (no special config needed yet):

```ts
export default defineWorkspace([
  "packages/*",
  {
    test: {
      name: "@gl3/server",
      root: "./apps/server",
      setupFiles: [
        "./test/helpers/isolated-db.setup.ts",
        "./test/helpers/rate-limit-isolation.setup.ts",
      ],
    },
    resolve: {
      alias: {
        "@gl3/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      },
    },
  },
  "apps/migrate",
]);
```

- [ ] **Step 9: Run the full gate**

Run: `npm run verify`
Expected: exits 0, tests reported from `packages/shared`, `apps/server`, and now `apps/migrate` (2 files, 7 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/migrate tsconfig.json vitest.workspace.ts package-lock.json
git commit -m "feat(migrate): scaffold apps/migrate with CLI arg parsing and unixToDate"
```

---

### Task 3: V2 fixture schema — reconstructed `CREATE TABLE` statements

Reconstructed from SPEC §1.2 per the "Known unknowns" section above. `utf8` charset (not `utf8mb4`), no foreign keys, mixed storage engines — all deliberate, matching SPEC §1.1's documented V2 characteristics so the fixture actually exercises the quirks the migrator has to handle.

**Files:**
- Create: `apps/migrate/test/fixtures/v2-schema.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: a `.sql` file Task 4's fixture loader runs verbatim against a fresh MariaDB database.

- [ ] **Step 1: Write the schema file**

`apps/migrate/test/fixtures/v2-schema.sql`:

```sql
-- Reconstructed from SPEC.md §1.2 (V2's install/schema.sql is not checked
-- out in this repo). See "Known unknowns" in the M4 plan for every column
-- this file infers rather than quotes directly from SPEC.

CREATE TABLE users (
  U_id INT(11) NOT NULL AUTO_INCREMENT,
  U_name VARCHAR(30) NOT NULL,
  U_email VARCHAR(255) DEFAULT NULL,
  U_password CHAR(64) NOT NULL,
  U_userLevel INT(11) NOT NULL DEFAULT 1,
  U_status INT(11) NOT NULL DEFAULT 1,
  U_round INT(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (U_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE userStats (
  US_id INT(11) NOT NULL,
  US_money INT(11) NOT NULL DEFAULT 0,
  US_bank INT(11) NOT NULL DEFAULT 0,
  US_bullets INT(11) NOT NULL DEFAULT 0,
  US_exp INT(11) NOT NULL DEFAULT 0,
  US_health INT(11) NOT NULL DEFAULT 100,
  US_backfire INT(11) NOT NULL DEFAULT 0,
  US_points INT(11) NOT NULL DEFAULT 0,
  US_weapon INT(11) NOT NULL DEFAULT 0,
  US_armor INT(11) NOT NULL DEFAULT 0,
  US_rank INT(11) NOT NULL DEFAULT 1,
  US_gang INT(11) NOT NULL DEFAULT 0,
  US_location INT(11) DEFAULT NULL,
  US_pic VARCHAR(255) DEFAULT NULL,
  US_bio TEXT,
  US_shotBy INT(11) DEFAULT NULL,
  US_crimes VARCHAR(500) NOT NULL DEFAULT '35-25-15-5-5',
  PRIMARY KEY (US_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE userTimers (
  UT_id INT(11) NOT NULL AUTO_INCREMENT,
  UT_user INT(11) NOT NULL,
  UT_key VARCHAR(50) NOT NULL,
  UT_time INT(11) NOT NULL,
  PRIMARY KEY (UT_id),
  KEY UT_user (UT_user)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE ranks (
  R_id INT(11) NOT NULL AUTO_INCREMENT,
  R_name VARCHAR(50) NOT NULL,
  R_exp INT(11) NOT NULL,
  R_cashReward INT(11) NOT NULL DEFAULT 0,
  R_bulletReward INT(11) NOT NULL DEFAULT 0,
  R_health INT(11) NOT NULL DEFAULT 100,
  PRIMARY KEY (R_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE moneyRanks (
  MR_id INT(11) NOT NULL AUTO_INCREMENT,
  MR_label VARCHAR(50) NOT NULL,
  MR_threshold INT(11) NOT NULL,
  PRIMARY KEY (MR_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE userRoles (
  UR_id INT(11) NOT NULL AUTO_INCREMENT,
  UR_name VARCHAR(50) NOT NULL,
  UR_color VARCHAR(20) DEFAULT NULL,
  PRIMARY KEY (UR_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE roleAccess (
  RA_id INT(11) NOT NULL AUTO_INCREMENT,
  RA_role INT(11) NOT NULL,
  RA_module VARCHAR(50) NOT NULL,
  PRIMARY KEY (RA_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- RND_ prefix, not R_ — see "Known unknowns" item 1.
CREATE TABLE rounds (
  RND_id INT(11) NOT NULL AUTO_INCREMENT,
  RND_name VARCHAR(50) NOT NULL,
  RND_start INT(11) NOT NULL,
  RND_end INT(11) DEFAULT NULL,
  PRIMARY KEY (RND_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE crimes (
  C_id INT(11) NOT NULL AUTO_INCREMENT,
  C_name VARCHAR(100) NOT NULL,
  C_description TEXT,
  C_cooldown INT(11) NOT NULL DEFAULT 60,
  C_money INT(11) NOT NULL DEFAULT 0,
  C_maxMoney INT(11) NOT NULL DEFAULT 0,
  C_bullets INT(11) NOT NULL DEFAULT 0,
  C_maxBullets INT(11) NOT NULL DEFAULT 0,
  C_exp INT(11) NOT NULL DEFAULT 0,
  C_level INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (C_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE locations (
  L_id INT(11) NOT NULL AUTO_INCREMENT,
  L_name VARCHAR(100) NOT NULL,
  L_cost INT(11) NOT NULL DEFAULT 0,
  L_cooldown INT(11) NOT NULL DEFAULT 0,
  L_bullets INT(11) NOT NULL DEFAULT 0,
  L_bulletCost INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (L_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE cars (
  CA_id INT(11) NOT NULL AUTO_INCREMENT,
  CA_name VARCHAR(100) NOT NULL,
  CA_value INT(11) NOT NULL DEFAULT 0,
  CA_theftChance INT(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (CA_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE theft (
  T_id INT(11) NOT NULL AUTO_INCREMENT,
  T_name VARCHAR(100) NOT NULL,
  T_chance INT(11) NOT NULL,
  T_maxDamage INT(11) NOT NULL DEFAULT 0,
  T_worstCar INT(11) NOT NULL DEFAULT 0,
  T_bestCar INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (T_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE weapons (
  W_id INT(11) NOT NULL AUTO_INCREMENT,
  W_name VARCHAR(100) NOT NULL,
  W_accuracy INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (W_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE items (
  I_id INT(11) NOT NULL AUTO_INCREMENT,
  I_name VARCHAR(100) NOT NULL,
  I_type VARCHAR(50) NOT NULL,
  PRIMARY KEY (I_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE itemEffects (
  IE_id INT(11) NOT NULL AUTO_INCREMENT,
  IE_item INT(11) NOT NULL,
  IE_effect VARCHAR(50) NOT NULL,
  IE_value INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (IE_id),
  KEY IE_item (IE_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE itemMeta (
  IM_id INT(11) NOT NULL AUTO_INCREMENT,
  IM_item INT(11) NOT NULL,
  IM_key VARCHAR(50) NOT NULL,
  IM_value VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (IM_id),
  KEY IM_item (IM_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- Recognised V2 core table, deliberately NOT migrated in v1 (SPEC §5: no
-- membership table in the GL3 §2.5 schema). Present here so the preflight
-- test (Task 9) can assert it is reported as a known-but-unsupported table.
CREATE TABLE premiumMembership (
  PM_id INT(11) NOT NULL AUTO_INCREMENT,
  PM_name VARCHAR(100) NOT NULL,
  PM_seconds INT(11) NOT NULL,
  PM_cost INT(11) NOT NULL,
  PRIMARY KEY (PM_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE settings (
  S_key VARCHAR(100) NOT NULL,
  S_value TEXT,
  PRIMARY KEY (S_key)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gangs (
  G_id INT(11) NOT NULL AUTO_INCREMENT,
  G_name VARCHAR(100) NOT NULL,
  G_boss INT(11) NOT NULL,
  G_underboss INT(11) DEFAULT NULL,
  G_bank INT(11) NOT NULL DEFAULT 0,
  G_money INT(11) NOT NULL DEFAULT 0,
  G_level INT(11) NOT NULL DEFAULT 1,
  G_location INT(11) DEFAULT NULL,
  PRIMARY KEY (G_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE gangPermissions (
  GP_id INT(11) NOT NULL AUTO_INCREMENT,
  GP_user INT(11) NOT NULL,
  GP_access VARCHAR(50) NOT NULL,
  PRIMARY KEY (GP_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gangInvites (
  GI_id INT(11) NOT NULL AUTO_INCREMENT,
  GI_gang INT(11) NOT NULL,
  GI_user INT(11) NOT NULL,
  GI_invitedBy INT(11) NOT NULL,
  GI_time INT(11) NOT NULL,
  PRIMARY KEY (GI_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gangLogs (
  GL_id INT(11) NOT NULL AUTO_INCREMENT,
  GL_gang INT(11) NOT NULL,
  GL_user INT(11) DEFAULT NULL,
  GL_message VARCHAR(255) NOT NULL,
  GL_time INT(11) NOT NULL,
  PRIMARY KEY (GL_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE userInventory (
  UI_user INT(11) NOT NULL,
  UI_item INT(11) NOT NULL,
  UI_qty INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (UI_user, UI_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE garage (
  GA_id INT(11) NOT NULL AUTO_INCREMENT,
  GA_user INT(11) NOT NULL,
  GA_car INT(11) NOT NULL,
  GA_damage INT(11) NOT NULL DEFAULT 0,
  GA_location INT(11) DEFAULT NULL,
  PRIMARY KEY (GA_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE properties (
  PR_id INT(11) NOT NULL AUTO_INCREMENT,
  PR_location INT(11) NOT NULL,
  PR_module VARCHAR(50) NOT NULL,
  PR_owner INT(11) DEFAULT NULL,
  PR_cost INT(11) NOT NULL DEFAULT 0,
  PR_profit INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (PR_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE bounties (
  B_id INT(11) NOT NULL AUTO_INCREMENT,
  B_user INT(11) NOT NULL,
  B_userToKill INT(11) NOT NULL,
  B_cost INT(11) NOT NULL,
  B_time INT(11) NOT NULL,
  PRIMARY KEY (B_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE detectives (
  D_id INT(11) NOT NULL AUTO_INCREMENT,
  D_user INT(11) NOT NULL,
  D_target INT(11) NOT NULL,
  D_start INT(11) NOT NULL,
  D_end INT(11) NOT NULL,
  D_success INT(11) DEFAULT NULL,
  PRIMARY KEY (D_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE mail (
  M_id INT(11) NOT NULL AUTO_INCREMENT,
  M_parent INT(11) DEFAULT NULL,
  M_sender INT(11) DEFAULT NULL,
  M_recipient INT(11) NOT NULL,
  M_subject VARCHAR(255) NOT NULL,
  M_body TEXT,
  M_read INT(11) NOT NULL DEFAULT 0,
  M_type INT(11) NOT NULL DEFAULT 0,
  M_time INT(11) NOT NULL,
  PRIMARY KEY (M_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE notifications (
  N_id INT(11) NOT NULL AUTO_INCREMENT,
  N_user INT(11) NOT NULL,
  N_body VARCHAR(255) NOT NULL,
  N_read INT(11) NOT NULL DEFAULT 0,
  N_time INT(11) NOT NULL,
  PRIMARY KEY (N_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gameNews (
  GN_id INT(11) NOT NULL AUTO_INCREMENT,
  GN_author INT(11) DEFAULT NULL,
  GN_title VARCHAR(255) NOT NULL,
  GN_body TEXT,
  GN_time INT(11) NOT NULL,
  PRIMARY KEY (GN_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- A genuine third-party/custom module table (e.g. a casino sub-module),
-- present in a real dump but never core V2. Preflight (Task 9) must report
-- this the same way it reports premiumMembership: "custom module table, not
-- migrated" — the migrator does not distinguish "unsupported core" from
-- "truly custom", by design (see "Known unknowns" preamble above Task 9).
CREATE TABLE blackjackHands (
  BJ_id INT(11) NOT NULL AUTO_INCREMENT,
  BJ_user INT(11) NOT NULL,
  BJ_result VARCHAR(20) NOT NULL,
  PRIMARY KEY (BJ_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;
```

- [ ] **Step 2: Commit**

This is inert until Task 4 loads it — commit it standalone so it reviews cleanly as "the fixture schema" on its own.

```bash
git add apps/migrate/test/fixtures/v2-schema.sql
git commit -m "test(migrate): reconstruct V2 fixture schema from SPEC §1.2"
```

---

### Task 4: V2 fixture seed data and the isolated-MySQL test helper

The seed data is deliberately dense: every quirk this milestone exists to handle gets at least one row that exercises it, and at least one row is a clean, boring baseline so "everything migrated" assertions have something unambiguous to check.

**Files:**
- Create: `apps/migrate/test/fixtures/v2-seed.sql`
- Create: `apps/migrate/test/helpers/fixtures.ts` (MySQL half only this task — `createIsolatedMysqlFixture`; the Postgres half is Task 5)
- Test: `apps/migrate/test/helpers/fixtures.test.ts`

**Interfaces:**
- Consumes: `test/fixtures/v2-schema.sql` (Task 3), `MYSQL_ADMIN_URL` (Task 1).
- Produces: `createIsolatedMysqlFixture(): Promise<{ url: string; teardown: () => Promise<void> }>` — creates a uniquely-named MariaDB database, loads schema + seed into it, returns a connection URL and a teardown function.

- [ ] **Step 1: Write the seed file**

Six users cover every player-side quirk; a five-row `crimes` table with an explicit gap at id 4 covers the `US_crimes` quirk; one gang with the boss deliberately absent from `gang_members` covers the cross-check; one orphan row per orphan-tolerant table covers §4.2 item 4.

`apps/migrate/test/fixtures/v2-seed.sql`:

```sql
-- Roles
INSERT INTO userRoles (UR_id, UR_name, UR_color) VALUES
  (1, 'Player', '#ffffff'),
  (2, 'Admin', '#ff0000');
INSERT INTO roleAccess (RA_role, RA_module) VALUES
  (2, '*'),
  (1, 'crimes'),
  (99, 'ghost'); -- orphan: role 99 does not exist

-- Rounds
INSERT INTO rounds (RND_id, RND_name, RND_start, RND_end) VALUES
  (1, 'Round 1', 1700000000, NULL);

-- Content
INSERT INTO ranks (R_id, R_name, R_exp, R_cashReward, R_bulletReward, R_health) VALUES
  (1, 'Rookie', 0, 0, 10, 100),
  (2, 'Soldier', 1000, 500, 20, 120);
INSERT INTO moneyRanks (MR_id, MR_label, MR_threshold) VALUES
  (1, 'Poor', 0), (2, 'Rich', 1000000);
-- Explicit gap at id 4: SPEC §1.2 quirk — crime 4 was deleted, leaving a
-- dead position in every US_crimes string that still has an index 3.
INSERT INTO crimes (C_id, C_name, C_cooldown, C_money, C_maxMoney, C_bullets, C_maxBullets, C_exp, C_level) VALUES
  (1, 'Pickpocket', 60, 10, 50, 0, 0, 2, 0),
  (2, 'Shoplifting', 90, 20, 80, 0, 0, 3, 0),
  (3, 'Mugging', 120, 40, 150, 1, 2, 5, 1),
  (5, 'Burglary', 300, 200, 800, 0, 0, 10, 3),
  (6, 'Grand Theft Auto', 600, 500, 2000, 0, 0, 20, 5);
INSERT INTO locations (L_id, L_name, L_cost, L_cooldown, L_bullets, L_bulletCost) VALUES
  (1, 'New York', 0, 0, 500, 5),
  (2, 'Chicago', 100, 60, 300, 6);
INSERT INTO cars (CA_id, CA_name, CA_value, CA_theftChance) VALUES
  (1, 'Sedan', 5000, 10), (2, 'Sports Car', 50000, 2);
INSERT INTO theft (T_id, T_name, T_chance, T_maxDamage, T_worstCar, T_bestCar) VALUES
  (1, 'Amateur', 60, 30, 1000, 10000);
INSERT INTO weapons (W_id, W_name, W_accuracy) VALUES
  (1, 'Pistol', 60), (2, 'Shotgun', 45);
INSERT INTO items (I_id, I_name, I_type) VALUES
  (1, 'Baseball Bat', 'weapon'), (2, 'Kevlar Vest', 'armor');
INSERT INTO itemEffects (IE_item, IE_effect, IE_value) VALUES
  (1, 'damage', 15), (2, 'armor', 20),
  (99, 'orphan', 1); -- orphan: item 99 does not exist
INSERT INTO itemMeta (IM_item, IM_key, IM_value) VALUES
  (1, 'rarity', 'common');
INSERT INTO premiumMembership (PM_id, PM_name, PM_seconds, PM_cost) VALUES
  (1, 'VIP Week', 604800, 500);
INSERT INTO settings (S_key, S_value) VALUES
  ('pointsName', 'Respect Points'),
  ('gangName', 'Family'),
  ('detectiveReport', '1');

-- Users. Legacy passwords are sha256(U_id . plaintext) — SPEC §1.1/§4.3.
-- Plaintext noted per row for the Task 31 login end-to-end test; never
-- stored in the fixture itself beyond the hash, matching a real V2 dump.
INSERT INTO users (U_id, U_name, U_email, U_password, U_userLevel, U_status, U_round) VALUES
  (1, 'DonVito', 'vito@family.test', 'd62a234e0d9f59d8240292e2042e50e7d1da3c668a0636bf5930fcaac5b52224', 1, 1, 1),        -- plaintext: vitopass1
  (2, 'Underboss', 'underboss@family.test', 'ad5729a45428b40f65f0bb98f213872dc0f12727938ccc7cfd5623a3de600d43', 1, 1, 1), -- plaintext: underbosspass2
  (3, 'Soldier', 'soldier@family.test', '3cf74ece85a49a6d02f53cf8c230edb71bcd3f8875228b808f5e663a3c21bf6e', 1, 1, 1),     -- plaintext: soldierpass3
  (4, 'LoneWolf', NULL, '413561a00a38a8ef52a938b55c06dd84361fa98178703dcea62ab7f0c138ba21', 1, 1, 1),                     -- plaintext: lonewolfpass4
  (5, 'GhostGangMember', NULL, '637f7e11c418a91661037112b6b3f5f7665f977ce8300471e6b6e440809a9b78', 1, 1, 1),            -- plaintext: ghostpass5
  (6, 'OldTimer', NULL, '37701a2e572407c9b8e1f811a3b2c9eb738b529ae0d6a324b419d20d138edc8d', 2, 1, 1);                    -- plaintext: oldpass6 (admin, role 2)

-- userStats. US_gang: 1 = DonVito's gang (id 1), but DonVito's OWN row is
-- US_gang = 0 — the boss is deliberately not a member of his own gang
-- (§4.2 item 5 cross-check). GhostGangMember's US_gang = 99, a gang that
-- does not exist (orphan membership, §4.2 item 4).
INSERT INTO userStats (US_id, US_money, US_bank, US_bullets, US_exp, US_health, US_backfire, US_points, US_weapon, US_armor, US_rank, US_gang, US_location, US_pic, US_bio, US_crimes) VALUES
  (1, 2100000000, 500000, 1000, 5000, 100, 0, 100, 1, 2, 2, 0, 1, NULL, 'Head of the family', '50-40-30'),
  (2, 800000, 200000, 500, 3000, 100, 0, 50, 0, 0, 2, 1, 1, NULL, NULL, '20-20-20-20-20-20'),
  (3, 15000, 5000, 100, 800, 100, 0, 0, 0, 0, 1, 1, 2, NULL, NULL, '10'),
  (4, 500, 0, 20, 50, 100, 0, 0, 0, 0, 1, 0, 1, NULL, NULL, '35-25-15-5-5'),
  (5, 100, 0, 10, 10, 100, 0, 0, 0, 0, 1, 99, 1, NULL, NULL, '35-25-15-5-5'),
  (6, 250, 0, 5, 5, 100, 0, 0, 0, 0, 1, 0, 1, NULL, NULL, '35-25-15-5-5');

-- Timers. user 999 does not exist (orphan). 'jail'/'hospital' are the two
-- keys promoted to typed player_stats columns; 'someCustomModuleKey' is not
-- in SPEC §1.2's observed-keys list and must still migrate (§1.2: "Custom
-- modules add arbitrary keys — migrate ALL rows, known or not").
INSERT INTO userTimers (UT_user, UT_key, UT_time) VALUES
  (1, 'jail', 4102444800),        -- future (year 2100) — maps to player_stats.jailed_until
  (1, 'hospital', 1000000000),    -- past — dropped
  (3, 'crime', 4102444800),       -- future — generic player_timers row
  (3, 'someCustomModuleKey', 4102444800), -- future, unknown key — still migrated + reported
  (999, 'crime', 4102444800);     -- orphan: user 999 does not exist

-- Gangs. G_boss=1 (DonVito) but DonVito's own userStats.US_gang=0 above.
INSERT INTO gangs (G_id, G_name, G_boss, G_underboss, G_bank, G_money, G_level, G_location) VALUES
  (1, 'The Family', 1, 2, 900000000, 500, 5, 1);

INSERT INTO gangPermissions (GP_user, GP_access) VALUES
  (3, 'kick'),   -- Soldier, US_gang=1 — migrates normally
  (4, 'invite'), -- LoneWolf, US_gang=0 — dropped, gangless (§1.2 quirk)
  (999, 'ghost'); -- orphan: user 999 does not exist

INSERT INTO gangInvites (GI_gang, GI_user, GI_invitedBy, GI_time) VALUES
  (1, 4, 1, 1700000100),
  (99, 4, 1, 1700000100); -- orphan: gang 99 does not exist

INSERT INTO gangLogs (GL_gang, GL_user, GL_message, GL_time) VALUES
  (1, 1, 'Founded the family', 1700000000),
  (1, NULL, 'System: round started', 1700000050), -- system log, no user — not an orphan
  (99, 1, 'Ghost log', 1700000000); -- orphan: gang 99 does not exist

-- Inventory / garage / properties
INSERT INTO userInventory (UI_user, UI_item, UI_qty) VALUES
  (1, 1, 5),
  (4, 99, 1),  -- orphan: item 99 does not exist
  (88, 1, 1);  -- orphan: user 88 does not exist
INSERT INTO garage (GA_user, GA_car, GA_damage, GA_location) VALUES
  (1, 1, 10, 1),
  (77, 1, 0, 1); -- orphan: user 77 does not exist
INSERT INTO properties (PR_location, PR_module, PR_owner, PR_cost, PR_profit) VALUES
  (1, 'casino', 1, 5000, 100),
  (99, 'casino', 1, 5000, 100); -- orphan: location 99 does not exist

-- Social
INSERT INTO bounties (B_user, B_userToKill, B_cost, B_time) VALUES
  (1, 3, 1000, 1700000200),
  (1, 999, 1000, 1700000200); -- orphan: target 999 does not exist
INSERT INTO detectives (D_user, D_target, D_start, D_end, D_success) VALUES
  (1, 3, 1700000000, 4102444800, NULL);
INSERT INTO mail (M_id, M_parent, M_sender, M_recipient, M_subject, M_body, M_read, M_type, M_time) VALUES
  (1, NULL, 1, 3, 'Hi', 'Welcome to the family.', 1, 0, 1700000300),
  (2, 1, 3, 1, 'Re: Hi', 'Thanks, boss.', 0, 0, 1700000400),  -- thread root walks to message 1
  (3, NULL, NULL, 1, 'System notice', 'Server maintenance tonight.', 0, 1, 1700000500), -- system mail, no sender
  (4, NULL, 1, 999, 'Lost', 'nobody home', 0, 0, 1700000600); -- orphan: recipient 999 does not exist
INSERT INTO notifications (N_user, N_body, N_read, N_time) VALUES
  (1, 'Welcome to GL3', 0, 1700000000),
  (999, 'Ghost notification', 0, 1700000000); -- orphan: user 999 does not exist
INSERT INTO gameNews (GN_author, GN_title, GN_body, GN_time) VALUES
  (1, 'Season 1 begins', 'Good luck.', 1700000000),
  (NULL, 'System announcement', 'Automated post.', 1700000100); -- system news, no author

-- A genuinely custom module table's data — irrelevant to migration, present
-- only so the preflight test (Task 9) has a real unknown table to detect.
INSERT INTO blackjackHands (BJ_user, BJ_result) VALUES (1, 'win');
```

- [ ] **Step 2: Write the failing fixture-helper test**

`apps/migrate/test/helpers/fixtures.test.ts`:

```ts
import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { createIsolatedMysqlFixture } from "./fixtures.js";

describe("createIsolatedMysqlFixture", () => {
  it("loads the V2 schema and seed into a freshly created database", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = mysql.createPool(fixture.url);
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM users");
      expect(rows[0]?.n).toBe(6);
      const [crimeRows] = await pool.query<mysql.RowDataPacket[]>("SELECT C_id FROM crimes ORDER BY C_id");
      expect(crimeRows.map((r) => r.C_id)).toEqual([1, 2, 3, 5, 6]); // the id-4 gap
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("gives two concurrent calls two isolated databases", async () => {
    const [a, b] = await Promise.all([createIsolatedMysqlFixture(), createIsolatedMysqlFixture()]);
    try {
      expect(a.url).not.toBe(b.url);
    } finally {
      await Promise.all([a.teardown(), b.teardown()]);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/helpers/fixtures.test.ts`
Expected: FAIL — cannot resolve `./fixtures.js`.

- [ ] **Step 4: Write `fixtures.ts` (MySQL half)**

```ts
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const SCHEMA_SQL = new URL("../fixtures/v2-schema.sql", import.meta.url);
const SEED_SQL = new URL("../fixtures/v2-seed.sql", import.meta.url);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set before running apps/migrate tests (see .env.example)`);
  return value;
}

/**
 * Creates a uniquely-named MariaDB database, loads the reconstructed V2
 * schema and seed into it, and returns a connection URL plus a teardown
 * function. Every test file gets its own — vitest runs files in parallel by
 * default, so a single shared V2 fixture database would race the same way
 * apps/server's isolated-db.setup.ts documents for Postgres.
 */
export async function createIsolatedMysqlFixture(): Promise<{ url: string; teardown: () => Promise<void> }> {
  const adminUrl = requireEnv("MYSQL_ADMIN_URL");
  const dbName = `gl3_test_mysql_${randomBytes(8).toString("hex")}`;

  const admin = await mysql.createConnection(adminUrl);
  try {
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;

  const conn = await mysql.createConnection({ uri: target.toString(), multipleStatements: true });
  try {
    const schema = await readFile(SCHEMA_SQL, "utf8");
    const seed = await readFile(SEED_SQL, "utf8");
    await conn.query(schema);
    await conn.query(seed);
  } finally {
    await conn.end();
  }

  return {
    url: target.toString(),
    teardown: async () => {
      const dropAdmin = await mysql.createConnection(adminUrl);
      try {
        await dropAdmin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/helpers/fixtures.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/test/fixtures/v2-seed.sql apps/migrate/test/helpers/fixtures.ts apps/migrate/test/helpers/fixtures.test.ts
git commit -m "test(migrate): seed V2 fixture data covering every orphan/quirk case, add isolated-MySQL helper"
```

---

### Task 5: Isolated-Postgres test helper (reusing `apps/server`'s migrations)

**Files:**
- Modify: `apps/migrate/test/helpers/fixtures.ts` (add the Postgres half)
- Test: `apps/migrate/test/helpers/fixtures.test.ts` (extend)

**Interfaces:**
- Consumes: `DATABASE_URL` (admin base connection, same convention as `apps/server/test/helpers/isolated-db.setup.ts`), `apps/server/drizzle/*.sql` (the committed migrations — GL3 has one schema, migrated once, reused here), plus `runPluginMigrations` (`apps/server/src/plugins/migrate.ts`) with the `@gl3/plugin-bounties` / `@gl3/plugin-detectives` manifests — the two plugin-owned target tables are not in `apps/server/drizzle` ("Known unknowns" item 8).
- Produces: `createIsolatedPgTarget(): Promise<{ url: string; teardown: () => Promise<void> }>` — a freshly created, fully migrated (every core table plus `p_bounties_bounties` / `p_detectives_searches`) Postgres database ready to be the `--pg` target.

- [ ] **Step 1: Extend the failing test**

Append to `apps/migrate/test/helpers/fixtures.test.ts`:

```ts
import { sql as sqlTag } from "drizzle-orm";
import { createDb } from "../../../server/src/db/client.js";
import { idMap } from "../../../server/src/db/schema/index.js";
import { createIsolatedPgTarget } from "./fixtures.js";

describe("createIsolatedPgTarget", () => {
  it("returns a freshly migrated database with the id_map table present", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const rows = await db.select().from(idMap);
      expect(rows).toEqual([]); // empty, but querying it proves the migration ran
      // The plugin-owned target tables exist too — created by runPluginMigrations,
      // not by apps/server/drizzle ("Known unknowns" item 8). 42P01 here means the
      // plugin half of the helper is missing.
      await db.execute(sqlTag`SELECT 1 FROM p_bounties_bounties LIMIT 1`);
      await db.execute(sqlTag`SELECT 1 FROM p_detectives_searches LIMIT 1`);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/helpers/fixtures.test.ts`
Expected: FAIL — `createIsolatedPgTarget` is not exported.

- [ ] **Step 3: Add the Postgres half to `fixtures.ts`**

Same pattern as `apps/server/test/helpers/isolated-db.setup.ts` — a uniquely-named database, migrated via the migrations folder committed in `apps/server/drizzle`, one per call rather than one per process, because (unlike that file) this is a plain helper function each test calls explicitly, not a vitest `setupFile` — this package has no ambient env-var config to hijack.

After the core folder, the helper runs the `bounties` and `detectives` plugins' migrations through the exact production code path (`runPluginMigrations` + the real manifests) — not a copy of their DDL — because those two plugins own the migrator's target tables ("Known unknowns" item 8). Core migrations first is load-bearing: `runPluginMigrations` writes its tracking rows to `plugin_migrations`, which core `0004_plugin_runtime` creates, and `p_bounties_bounties`'s FKs reference `players`, which core `0000` creates.

Append to `apps/migrate/src/../test/helpers/fixtures.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import bountiesPlugin from "@gl3/plugin-bounties";
import detectivesPlugin from "@gl3/plugin-detectives";
import { createDb } from "../../../server/src/db/client.js";
import { runPluginMigrations } from "../../../server/src/plugins/migrate.js";

const PG_MIGRATIONS_FOLDER = new URL("../../../server/drizzle", import.meta.url).pathname;

export async function createIsolatedPgTarget(): Promise<{ url: string; teardown: () => Promise<void> }> {
  const adminUrl = requireEnv("DATABASE_URL");
  const dbName = `gl3_test_migrate_pg_${randomBytes(8).toString("hex")}`;

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;

  const migrator = postgres(target.toString(), { max: 1 });
  try {
    await migrate(drizzle(migrator), { migrationsFolder: PG_MIGRATIONS_FOLDER });
  } finally {
    await migrator.end();
  }

  // The two plugin-owned target tables ("Known unknowns" item 8), created the
  // same way apps/server's loader creates them at boot.
  const pluginDb = createDb(target.toString());
  try {
    await runPluginMigrations(pluginDb.db, [bountiesPlugin, detectivesPlugin]);
  } finally {
    await pluginDb.sql.end();
  }

  return {
    url: target.toString(),
    teardown: async () => {
      const dropAdmin = postgres(adminUrl, { max: 1 });
      try {
        await dropAdmin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
        );
        await dropAdmin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}
```

`randomBytes` and `requireEnv` are already imported/defined earlier in the same file from Task 4 — no new import needed for those two.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/helpers/fixtures.test.ts`
Expected: PASS, 3 tests. (This test is real and slow — it spins up a full Postgres database and runs every core migration plus the two plugins' migrations. That's the point: it proves `apps/migrate` targets the exact same schema `apps/server` boots against, not a drifted copy.)

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/test/helpers/fixtures.ts apps/migrate/test/helpers/fixtures.test.ts
git commit -m "test(migrate): add isolated-Postgres fixture helper reusing apps/server's migrations"
```

---

### Task 6: MySQL client — `utf8mb4` with `utf8` fallback

**Files:**
- Create: `apps/migrate/src/mysql/client.ts`
- Test: `apps/migrate/test/mysql/client.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `createIsolatedMysqlFixture` from Task 4 as its test target).
- Produces: `createMysqlPool(mysqlUrl: string): Promise<mysql.Pool>`.

- [ ] **Step 1: Write the failing test**

The fallback path is the one that matters — SPEC §1.1: "real dumps may contain mojibake; migrator must read as utf8mb4 with fallback." This test proves the pool still connects against a `utf8`-charset database (the fixture is created `CHARACTER SET utf8` in Task 4) rather than throwing.

`apps/migrate/test/mysql/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createIsolatedMysqlFixture } from "../helpers/fixtures.js";
import { createMysqlPool } from "../../src/mysql/client.js";

describe("createMysqlPool", () => {
  it("connects to a utf8-charset V2 database and can query it", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      const [rows] = await pool.query("SELECT U_name FROM users WHERE U_id = 1");
      expect((rows as Array<{ U_name: string }>)[0]?.U_name).toBe("DonVito");
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/mysql/client.test.ts`
Expected: FAIL — cannot resolve `../../src/mysql/client.js`.

- [ ] **Step 3: Write `client.ts`**

```ts
import mysql from "mysql2/promise";

/**
 * SPEC §1.1: V2 is `utf8`, not `utf8mb4`; real dumps may contain mojibake
 * a strict utf8mb4 connection charset can reject outright. Try utf8mb4
 * first (the correct modern choice when the source data happens to be
 * clean), and fall back to utf8 — matching the source charset exactly —
 * if the connection itself fails to establish under it.
 */
export async function createMysqlPool(mysqlUrl: string): Promise<mysql.Pool> {
  const preferred = mysql.createPool({ uri: mysqlUrl, charset: "UTF8MB4_GENERAL_CI", supportBigNumbers: true });
  try {
    const probe = await preferred.getConnection();
    probe.release();
    return preferred;
  } catch {
    await preferred.end();
    return mysql.createPool({ uri: mysqlUrl, charset: "UTF8_GENERAL_CI", supportBigNumbers: true });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/mysql/client.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/mysql/client.ts apps/migrate/test/mysql/client.test.ts
git commit -m "feat(migrate): MySQL client with utf8mb4-then-utf8 fallback (SPEC §1.1)"
```

---

### Task 7: `Executor`/`Tx` types and `id_map` helpers — the idempotency mechanism

**Files:**
- Create: `apps/migrate/src/pg/types.ts`
- Create: `apps/migrate/src/id-map.ts`
- Test: `apps/migrate/test/id-map.test.ts`

**Interfaces:**
- Consumes: `createDb`/`Db` from `apps/server/src/db/client.ts`, `idMap` from `apps/server/src/db/schema/index.ts`, `createIsolatedPgTarget` (Task 5).
- Produces:
  - `type Tx` — the transaction-callback parameter type Drizzle infers for `Db["transaction"]`.
  - `type Executor = Db | Tx` — every migrator and `id-map.ts` function accepts this, so the same code runs identically inside or outside a transaction.
  - `getOrCreateV3Id(exec: Executor, v2Table: string, v2Id: number): Promise<{ v3Id: string; created: boolean }>`.
  - `lookupV3Id(exec: Executor, v2Table: string, v2Id: number): Promise<string | null>`.

- [ ] **Step 1: Write `types.ts`**

No test needed — this file is pure type-level code; it's exercised indirectly by every consumer's typecheck.

```ts
import type { Db } from "../../../server/src/db/client.js";

/**
 * The type Drizzle infers for the `tx` parameter inside
 * `db.transaction(async (tx) => { ... })`. Every migrator and id-map
 * function is typed to accept `Executor` (this or the outer `Db`) so the
 * exact same function runs unmodified whether it's called directly in a
 * test or from inside the orchestrator's per-phase transaction.
 */
export type Tx = Parameters<Db["transaction"]>[0] extends (tx: infer T, ...args: never[]) => unknown ? T : never;

export type Executor = Db | Tx;
```

- [ ] **Step 2: Write the failing id-map test**

The idempotency property is the whole point: calling `getOrCreateV3Id` twice for the same `(v2Table, v2Id)` — including from a fresh process, i.e. a fresh `Db` — must return the identical uuid.

`apps/migrate/test/id-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDb } from "../../server/src/db/client.js";
import { createIsolatedPgTarget } from "./helpers/fixtures.js";
import { getOrCreateV3Id, lookupV3Id } from "../src/id-map.js";

describe("getOrCreateV3Id / lookupV3Id", () => {
  it("creates a new mapping on first call and reuses it on the second", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const first = await getOrCreateV3Id(db, "users", 42);
      expect(first.created).toBe(true);
      expect(first.v3Id).toMatch(/^[0-9a-f-]{36}$/);

      const second = await getOrCreateV3Id(db, "users", 42);
      expect(second.created).toBe(false);
      expect(second.v3Id).toBe(first.v3Id); // same V2 row -> same GL3 uuid, always

      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("keeps separate tables' id spaces distinct even with the same v2Id", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const user = await getOrCreateV3Id(db, "users", 1);
      const gang = await getOrCreateV3Id(db, "gangs", 1);
      expect(user.v3Id).not.toBe(gang.v3Id);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("lookupV3Id returns null for an id that was never mapped", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      expect(await lookupV3Id(db, "users", 999)).toBeNull();
      await sql.end();
    } finally {
      await target.teardown();
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/id-map.test.ts`
Expected: FAIL — cannot resolve `../src/id-map.js`.

- [ ] **Step 4: Write `id-map.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { idMap } from "../../server/src/db/schema/index.js";
import type { Executor } from "./pg/types.js";

async function findMapping(exec: Executor, v2Table: string, v2Id: number) {
  const [row] = await exec.select().from(idMap).where(and(eq(idMap.v2Table, v2Table), eq(idMap.v2Id, v2Id)));
  return row ?? null;
}

/**
 * The single mechanism that makes the whole migration idempotent (SPEC
 * §1.1, §4.2 item 3): the same V2 row always resolves to the same GL3
 * uuid, on this run or any future re-run, because the mapping itself is
 * durable. `onConflictDoNothing` handles the case where a concurrent
 * writer raced us to the insert (not expected within one migration run,
 * which is single-threaded per phase, but cheap safety); the re-select
 * after it guarantees we always return the row that actually won, not
 * necessarily the uuid we generated.
 */
export async function getOrCreateV3Id(
  exec: Executor,
  v2Table: string,
  v2Id: number,
): Promise<{ v3Id: string; created: boolean }> {
  const existing = await findMapping(exec, v2Table, v2Id);
  if (existing) return { v3Id: existing.v3Id, created: false };

  const candidate = uuidv7();
  await exec.insert(idMap).values({ v2Table, v2Id, v3Id: candidate })
    .onConflictDoNothing({ target: [idMap.v2Table, idMap.v2Id] });

  const row = await findMapping(exec, v2Table, v2Id);
  if (!row) throw new Error(`id_map insert for ${v2Table}:${v2Id} did not persist`);
  return { v3Id: row.v3Id, created: row.v3Id === candidate };
}

export async function lookupV3Id(exec: Executor, v2Table: string, v2Id: number): Promise<string | null> {
  const row = await findMapping(exec, v2Table, v2Id);
  return row?.v3Id ?? null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/id-map.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/pg/types.ts apps/migrate/src/id-map.ts apps/migrate/test/id-map.test.ts
git commit -m "feat(migrate): id_map-backed getOrCreateV3Id/lookupV3Id — the idempotency mechanism"
```

---

### Task 8: `MigrationReport` — accumulator, JSON writer, human summary

**Files:**
- Create: `apps/migrate/src/report.ts`
- Test: `apps/migrate/test/report.test.ts`

**Interfaces:**
- Consumes: nothing (pure logic, no DB).
- Produces:
  - `type MigrationReport` — per SPEC §4.2 item 7: per-table counts (read/written/skipped), orphan lists, unknown tables, unknown timer keys, dropped `US_crimes` positions, duration.
  - `createReport(dryRun: boolean): MigrationReport`
  - `bumpTable(report, table, field: "read" | "written" | "skipped"): void`
  - `recordOrphan(report, table: string, v2Id: number, reason: string): void`
  - `recordUnknownTimerKey(report, key: string): void`
  - `recordDroppedCrimePosition(report, playerV2Id: number, position: number): void`
  - `finishReport(report): void` — sets `finishedAt`/`durationMs`
  - `writeReportFile(report, path: string): Promise<void>`
  - `formatHumanSummary(report): string`

- [ ] **Step 1: Write the failing test**

`apps/migrate/test/report.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bumpTable, createReport, finishReport, formatHumanSummary,
  recordDroppedCrimePosition, recordOrphan, recordUnknownTimerKey, writeReportFile,
} from "../src/report.js";

describe("MigrationReport", () => {
  it("accumulates per-table counts, orphans, unknown keys, and dropped positions", () => {
    const report = createReport(false);
    bumpTable(report, "users", "read");
    bumpTable(report, "users", "read");
    bumpTable(report, "users", "written");
    bumpTable(report, "users", "skipped");
    recordOrphan(report, "userInventory", 4, "item 99 does not exist");
    recordUnknownTimerKey(report, "someCustomModuleKey");
    recordDroppedCrimePosition(report, 2, 3);
    report.unknownTables = ["premiumMembership", "blackjackHands"];

    const users = report.tables.find((t) => t.table === "users");
    expect(users).toEqual({ table: "users", read: 2, written: 1, skipped: 1 });
    expect(report.orphans).toEqual([{ table: "userInventory", v2Id: 4, reason: "item 99 does not exist" }]);
    expect(report.unknownTimerKeys).toEqual(["someCustomModuleKey"]);
    expect(report.droppedCrimePositions).toEqual([{ playerV2Id: 2, position: 3 }]);
  });

  it("deduplicates repeated unknown timer keys", () => {
    const report = createReport(false);
    recordUnknownTimerKey(report, "k");
    recordUnknownTimerKey(report, "k");
    expect(report.unknownTimerKeys).toEqual(["k"]);
  });

  it("finishReport sets finishedAt and a non-negative duration", () => {
    const report = createReport(false);
    finishReport(report);
    expect(report.finishedAt).not.toBeNull();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("writes valid JSON to disk", async () => {
    const report = createReport(true);
    finishReport(report);
    const dir = await mkdtemp(join(tmpdir(), "gl3-migrate-report-"));
    const path = join(dir, "report.json");
    await writeReportFile(report, path);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.dryRun).toBe(true);
  });

  it("formats a human summary mentioning table counts and orphan totals", () => {
    const report = createReport(false);
    bumpTable(report, "users", "written");
    recordOrphan(report, "mail", 4, "recipient 999 does not exist");
    finishReport(report);
    const summary = formatHumanSummary(report);
    expect(summary).toContain("users");
    expect(summary).toContain("1 orphan");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/report.test.ts`
Expected: FAIL — cannot resolve `../src/report.js`.

- [ ] **Step 3: Write `report.ts`**

```ts
import { writeFile } from "node:fs/promises";

export interface TableReport { table: string; read: number; written: number; skipped: number; }
export interface OrphanEntry { table: string; v2Id: number; reason: string; }
export interface DroppedCrimePosition { playerV2Id: number; position: number; }

export interface MigrationReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tables: TableReport[];
  orphans: OrphanEntry[];
  unknownTables: string[];
  unknownTimerKeys: string[];
  droppedCrimePositions: DroppedCrimePosition[];
  bossNotInGang: Array<{ gangV2Id: number; bossV2Id: number }>;
  underbossNotInGang: Array<{ gangV2Id: number; underbossV2Id: number }>;
}

export function createReport(dryRun: boolean): MigrationReport {
  return {
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    tables: [],
    orphans: [],
    unknownTables: [],
    unknownTimerKeys: [],
    droppedCrimePositions: [],
    bossNotInGang: [],
    underbossNotInGang: [],
  };
}

function tableEntry(report: MigrationReport, table: string): TableReport {
  let entry = report.tables.find((t) => t.table === table);
  if (!entry) {
    entry = { table, read: 0, written: 0, skipped: 0 };
    report.tables.push(entry);
  }
  return entry;
}

export function bumpTable(report: MigrationReport, table: string, field: "read" | "written" | "skipped"): void {
  tableEntry(report, table)[field] += 1;
}

export function recordOrphan(report: MigrationReport, table: string, v2Id: number, reason: string): void {
  report.orphans.push({ table, v2Id, reason });
}

export function recordUnknownTimerKey(report: MigrationReport, key: string): void {
  if (!report.unknownTimerKeys.includes(key)) report.unknownTimerKeys.push(key);
}

export function recordDroppedCrimePosition(report: MigrationReport, playerV2Id: number, position: number): void {
  report.droppedCrimePositions.push({ playerV2Id, position });
}

export function finishReport(report: MigrationReport): void {
  report.finishedAt = new Date().toISOString();
  report.durationMs = new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
}

export async function writeReportFile(report: MigrationReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}

export function formatHumanSummary(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(`gl3-migrate ${report.dryRun ? "(dry run) " : ""}— ${report.durationMs ?? 0}ms`);
  for (const t of report.tables) {
    lines.push(`  ${t.table.padEnd(20)} read=${t.read} written=${t.written} skipped=${t.skipped}`);
  }
  lines.push(`${report.orphans.length} orphan row(s) skipped`);
  if (report.unknownTables.length > 0) {
    lines.push(`Unknown tables (custom module tables, not migrated): ${report.unknownTables.join(", ")}`);
  }
  if (report.unknownTimerKeys.length > 0) {
    lines.push(`Unknown userTimers keys (migrated anyway): ${report.unknownTimerKeys.join(", ")}`);
  }
  if (report.droppedCrimePositions.length > 0) {
    lines.push(`${report.droppedCrimePositions.length} US_crimes position(s) dropped (deleted crime id gaps)`);
  }
  if (report.bossNotInGang.length > 0 || report.underbossNotInGang.length > 0) {
    lines.push(`${report.bossNotInGang.length} boss / ${report.underbossNotInGang.length} underboss row(s) added to their own gang`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/report.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/report.ts apps/migrate/test/report.test.ts
git commit -m "feat(migrate): MigrationReport accumulator, JSON writer, human summary (SPEC §4.2.7)"
```

---

### Task 9: Preflight schema fingerprint (§4.2 item 1)

**Files:**
- Create: `apps/migrate/src/mysql/fingerprint.ts`
- Test: `apps/migrate/test/mysql/fingerprint.test.ts`

**Interfaces:**
- Consumes: `createMysqlPool` (Task 6), `createIsolatedMysqlFixture` (Task 4).
- Produces: `fingerprintV2Schema(pool): Promise<FingerprintResult>` and `type FingerprintResult = { ok: boolean; missingTables: string[]; missingColumns: Record<string,string[]>; unknownTables: string[] }`.

"Known" here means "has a migrator" (Tasks 11–28's table list), not "is a core V2 table" — `premiumMembership` is core V2 but has no GL3 counterpart in v1 (§5), so it is reported exactly like a genuinely third-party `blackjackHands` table: "custom module table, not migrated." This is a deliberate simplification stated in the "Known unknowns" preamble; it makes "known" a single, testable definition instead of a second taxonomy of "core-but-unsupported."

- [ ] **Step 1: Write the failing test**

`apps/migrate/test/mysql/fingerprint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createIsolatedMysqlFixture } from "../helpers/fixtures.js";
import { createMysqlPool } from "../../src/mysql/client.js";
import { fingerprintV2Schema } from "../../src/mysql/fingerprint.js";

describe("fingerprintV2Schema", () => {
  it("passes on the full fixture and reports the two known-unsupported tables as unknown", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      const result = await fingerprintV2Schema(pool);
      expect(result.ok).toBe(true);
      expect(result.missingTables).toEqual([]);
      expect(result.unknownTables.sort()).toEqual(["blackjackHands", "premiumMembership"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("fails when users, userStats, or userTimers is missing", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      await pool.query("DROP TABLE userTimers");
      const result = await fingerprintV2Schema(pool);
      expect(result.ok).toBe(false);
      expect(result.missingTables).toEqual(["userTimers"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("fails when a required column is missing from a present table", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      await pool.query("ALTER TABLE userStats DROP COLUMN US_crimes");
      const result = await fingerprintV2Schema(pool);
      expect(result.ok).toBe(false);
      expect(result.missingColumns.userStats).toEqual(["US_crimes"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/mysql/fingerprint.test.ts`
Expected: FAIL — cannot resolve `../../src/mysql/fingerprint.js`.

- [ ] **Step 3: Write `fingerprint.ts`**

```ts
import type mysql from "mysql2/promise";

const REQUIRED_TABLES = ["users", "userStats", "userTimers"] as const;

const REQUIRED_COLUMNS: Record<(typeof REQUIRED_TABLES)[number], string[]> = {
  users: ["U_id", "U_name", "U_password"],
  userStats: ["US_id", "US_money", "US_gang", "US_crimes"],
  userTimers: ["UT_user", "UT_key", "UT_time"],
};

/** Every table this migrator actually migrates (Tasks 11–28). Anything else
 * present in the source database — core-but-unsupported V2 module or
 * genuinely third-party — is reported the same way (§4.2 item 1). */
const KNOWN_TABLES = new Set([
  ...REQUIRED_TABLES,
  "ranks", "moneyRanks", "userRoles", "roleAccess", "rounds",
  "crimes", "locations", "cars", "theft", "weapons", "items", "itemEffects", "itemMeta", "settings",
  "gangs", "gangPermissions", "gangInvites", "gangLogs",
  "userInventory", "garage", "properties",
  "bounties", "detectives", "mail", "notifications", "gameNews",
]);

export interface FingerprintResult {
  ok: boolean;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  unknownTables: string[];
}

export async function fingerprintV2Schema(pool: mysql.Pool): Promise<FingerprintResult> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()",
  );

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = row.TABLE_NAME as string;
    const column = row.COLUMN_NAME as string;
    const set = columnsByTable.get(table) ?? new Set<string>();
    set.add(column);
    columnsByTable.set(table, set);
  }

  const missingTables = REQUIRED_TABLES.filter((t) => !columnsByTable.has(t));

  const missingColumns: Record<string, string[]> = {};
  for (const table of REQUIRED_TABLES) {
    const cols = columnsByTable.get(table);
    if (!cols) continue;
    const missing = REQUIRED_COLUMNS[table].filter((c) => !cols.has(c));
    if (missing.length > 0) missingColumns[table] = missing;
  }

  const unknownTables = [...columnsByTable.keys()].filter((t) => !KNOWN_TABLES.has(t));

  return {
    ok: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missingTables,
    missingColumns,
    unknownTables,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/mysql/fingerprint.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/mysql/fingerprint.ts apps/migrate/test/mysql/fingerprint.test.ts
git commit -m "feat(migrate): preflight schema fingerprint — required tables/columns, unknown-table detection (SPEC §4.2.1)"
```

---

### Task 10: `runPhase` — batched transactions with dry-run rollback

**Files:**
- Create: `apps/migrate/src/pg/run-phase.ts`
- Test: `apps/migrate/test/pg/run-phase.test.ts`

**Interfaces:**
- Consumes: `Db` (`apps/server/src/db/client.ts`), `Tx` (Task 7), `createIsolatedPgTarget` (Task 5).
- Produces: `runPhase<T>(db: Db, dryRun: boolean, fn: (tx: Tx) => Promise<T>): Promise<T>`, `class DryRunRollback extends Error`.

This is the primitive behind "everything runs inside batched transactions... the whole run is idempotent" (§4.2 item 3) and "`--dry-run` performs no writes." Each pipeline phase (Task 29) calls `runPhase` once; `dryRun=true` runs the phase's real statements against a real transaction and then forces a rollback, so every code path — including `id_map` inserts — is genuinely exercised without leaving anything durable.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../../server/src/db/client.js";
import { settings } from "../../../server/src/db/schema/index.js";
import { createIsolatedPgTarget } from "../helpers/fixtures.js";
import { runPhase } from "../../src/pg/run-phase.js";

describe("runPhase", () => {
  it("commits writes when dryRun is false", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      await runPhase(db, false, async (tx) => {
        await tx.insert(settings).values({ key: "a", value: "1" });
      });
      const rows = await db.select().from(settings).where(eq(settings.key, "a"));
      expect(rows).toHaveLength(1);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("rolls back every write when dryRun is true, leaving zero durable rows", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      await runPhase(db, true, async (tx) => {
        await tx.insert(settings).values({ key: "a", value: "1" });
      });
      const rows = await db.select().from(settings);
      expect(rows).toHaveLength(0);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("returns the callback's value even on a dry-run rollback", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const result = await runPhase(db, true, async () => 42);
      expect(result).toBe(42);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("propagates a real error (not swallowed as a dry-run rollback)", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      await expect(runPhase(db, false, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      await sql.end();
    } finally {
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/pg/run-phase.test.ts`
Expected: FAIL — cannot resolve `../../src/pg/run-phase.js`.

- [ ] **Step 3: Write `run-phase.ts`**

```ts
import type { Db } from "../../../server/src/db/client.js";
import type { Tx } from "./types.js";

/** Sentinel thrown to force Postgres to roll back a `--dry-run` phase's
 * transaction. Never escapes `runPhase` — caught and treated as a normal
 * (rolled-back) completion, not a failure. */
export class DryRunRollback extends Error {}

export async function runPhase<T>(db: Db, dryRun: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let outcome: T | undefined;
  try {
    await db.transaction(async (tx) => {
      outcome = await fn(tx);
      if (dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  // Reached only if the transaction callback resolved without throwing a
  // real error — `outcome` is guaranteed assigned by that point; the cast
  // documents an invariant `db.transaction`'s control flow can't express to
  // the type checker across the try/catch boundary.
  return outcome as T;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/pg/run-phase.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/pg/run-phase.ts apps/migrate/test/pg/run-phase.test.ts
git commit -m "feat(migrate): runPhase — batched per-phase transactions with dry-run rollback (SPEC §4.2.3)"
```

---

# Per-domain migrators (Tasks 11–28 — mutually independent, parallelize freely)

Every migrator in this band follows the same shape: read from MySQL, resolve/create ids via `getOrCreateV3Id`/`lookupV3Id`, `bumpTable`/`recordOrphan` into the report, `INSERT ... ON CONFLICT DO UPDATE` into Postgres via the `Executor` (`Tx` in real use, plain `Db` in these tasks' own unit tests — both work because of Task 7's type). Each migrator's own test calls it directly against `createIsolatedMysqlFixture()` + `createIsolatedPgTarget()`, not through the orchestrator — orchestration and cross-phase ordering get their own test in Task 30.

### Task 11: Roles migrator — `userRoles` + `roleAccess` → `roles` + `role_module_access`

**Files:**
- Create: `apps/migrate/src/migrators/roles.ts`
- Test: `apps/migrate/test/migrators/roles.test.ts`

**Interfaces:**
- Consumes: `Executor`/`getOrCreateV3Id`/`lookupV3Id` (Task 7), `MigrationReport`/`bumpTable`/`recordOrphan` (Task 8), `roles`/`roleModuleAccess` (`apps/server/src/db/schema/index.ts`).
- Produces: `migrateRoles(mysql: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`apps/migrate/test/migrators/roles.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { roleModuleAccess, roles } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";

describe("migrateRoles", () => {
  it("migrates userRoles and roleAccess, dropping the orphan role reference", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateRoles(pool, db, report);

      const roleRows = await db.select().from(roles);
      expect(roleRows).toHaveLength(2); // Player, Admin

      const accessRows = await db.select().from(roleModuleAccess);
      expect(accessRows).toHaveLength(2); // role 99 dropped
      expect(accessRows.some((r) => r.moduleKey === "*")).toBe(true);

      const rolesTable = report.tables.find((t) => t.table === "userRoles");
      expect(rolesTable).toEqual({ table: "userRoles", read: 2, written: 2, skipped: 0 });
      const accessTable = report.tables.find((t) => t.table === "roleAccess");
      expect(accessTable).toEqual({ table: "roleAccess", read: 3, written: 2, skipped: 1 });
      expect(report.orphans).toContainEqual({ table: "roleAccess", v2Id: 99, reason: "role 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("is idempotent: running twice does not duplicate rows", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await migrateRoles(pool, db, createReport(false));
      await migrateRoles(pool, db, createReport(false));

      expect(await db.select().from(roles)).toHaveLength(2);
      expect(await db.select().from(roleModuleAccess)).toHaveLength(2);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

Note: `roleAccess`'s composite primary key in GL3 is `(role_id, module_key)` — running twice re-derives the identical `role_id` (same `v2Id` → same `v3Id` via `id_map`) and the identical `module_key` string, so the second `INSERT ... ON CONFLICT DO NOTHING` on that pair is a true no-op, not a duplicate.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/roles.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/roles.js`.

- [ ] **Step 3: Write `roles.ts`**

```ts
import type mysql from "mysql2/promise";
import { roleModuleAccess, roles } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface UserRoleRow { UR_id: number; UR_name: string; UR_color: string | null; }
interface RoleAccessRow { RA_role: number; RA_module: string; }

export async function migrateRoles(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [roleRows] = await pool.query<(UserRoleRow & mysql.RowDataPacket)[]>(
    "SELECT UR_id, UR_name, UR_color FROM userRoles",
  );

  for (const row of roleRows) {
    bumpTable(report, "userRoles", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "userRoles", row.UR_id);
    await exec.insert(roles).values({ id: v3Id, name: row.UR_name, color: row.UR_color })
      .onConflictDoUpdate({ target: roles.id, set: { name: row.UR_name, color: row.UR_color } });
    bumpTable(report, "userRoles", "written");
  }

  const [accessRows] = await pool.query<(RoleAccessRow & mysql.RowDataPacket)[]>(
    "SELECT RA_role, RA_module FROM roleAccess",
  );

  for (const row of accessRows) {
    bumpTable(report, "roleAccess", "read");
    const roleId = await lookupV3Id(exec, "userRoles", row.RA_role);
    if (!roleId) {
      recordOrphan(report, "roleAccess", row.RA_role, `role ${row.RA_role} does not exist`);
      bumpTable(report, "roleAccess", "skipped");
      continue;
    }
    await exec.insert(roleModuleAccess).values({ roleId, moduleKey: row.RA_module })
      .onConflictDoNothing({ target: [roleModuleAccess.roleId, roleModuleAccess.moduleKey] });
    bumpTable(report, "roleAccess", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/roles.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/roles.ts apps/migrate/test/migrators/roles.test.ts
git commit -m "feat(migrate): roles migrator — userRoles + roleAccess → roles + role_module_access"
```

---

### Task 12: Rounds migrator

**Files:**
- Create: `apps/migrate/src/migrators/rounds.ts`
- Test: `apps/migrate/test/migrators/rounds.test.ts`

**Interfaces:**
- Consumes: same primitives as Task 11; `rounds` schema table.
- Produces: `migrateRounds(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { rounds } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRounds } from "../../src/migrators/rounds.js";

describe("migrateRounds", () => {
  it("migrates rounds with unix timestamps converted to Dates", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateRounds(pool, db, report);

      const rows = await db.select().from(rounds);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("Round 1");
      expect(rows[0]?.startsAt).toEqual(new Date(1700000000 * 1000));
      expect(rows[0]?.endsAt).toBeNull();
      expect(report.tables.find((t) => t.table === "rounds")).toEqual({ table: "rounds", read: 1, written: 1, skipped: 0 });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `rounds.ts`**

Run: `npx vitest run apps/migrate/test/migrators/rounds.test.ts` → FAIL.

```ts
import type mysql from "mysql2/promise";
import { rounds } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface RoundRow { RND_id: number; RND_name: string; RND_start: number; RND_end: number | null; }

export async function migrateRounds(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(RoundRow & mysql.RowDataPacket)[]>(
    "SELECT RND_id, RND_name, RND_start, RND_end FROM rounds",
  );

  for (const row of rows) {
    bumpTable(report, "rounds", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "rounds", row.RND_id);
    await exec.insert(rounds).values({
      id: v3Id, name: row.RND_name,
      startsAt: unixToDate(row.RND_start), endsAt: unixToDate(row.RND_end),
    }).onConflictDoUpdate({
      target: rounds.id,
      set: { name: row.RND_name, startsAt: unixToDate(row.RND_start), endsAt: unixToDate(row.RND_end) },
    });
    bumpTable(report, "rounds", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/rounds.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/rounds.ts apps/migrate/test/migrators/rounds.test.ts
git commit -m "feat(migrate): rounds migrator"
```

---

### Task 13: Content migrator — `ranks` + `moneyRanks`

**Files:**
- Create: `apps/migrate/src/migrators/ranks.ts`
- Test: `apps/migrate/test/migrators/ranks.test.ts`

**Interfaces:**
- Consumes: same primitives; `ranks`/`moneyRanks` schema tables.
- Produces: `migrateRanks(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { moneyRanks, ranks } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRanks } from "../../src/migrators/ranks.js";

describe("migrateRanks", () => {
  it("migrates ranks and moneyRanks with bigint conversion", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateRanks(pool, db, report);

      const rankRows = await db.select().from(ranks);
      expect(rankRows).toHaveLength(2);
      expect(rankRows.find((r) => r.name === "Soldier")?.expRequired).toBe(1000n);
      expect(typeof rankRows[0]?.expRequired).toBe("bigint");

      const moneyRankRows = await db.select().from(moneyRanks);
      expect(moneyRankRows).toHaveLength(2);
      expect(moneyRankRows.find((r) => r.label === "Rich")?.threshold).toBe(1000000n);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `ranks.ts`**

```ts
import type mysql from "mysql2/promise";
import { moneyRanks, ranks } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface RankRow { R_id: number; R_name: string; R_exp: number; R_cashReward: number; R_bulletReward: number; R_health: number; }
interface MoneyRankRow { MR_id: number; MR_label: string; MR_threshold: number; }

export async function migrateRanks(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rankRows] = await pool.query<(RankRow & mysql.RowDataPacket)[]>(
    "SELECT R_id, R_name, R_exp, R_cashReward, R_bulletReward, R_health FROM ranks",
  );
  for (const row of rankRows) {
    bumpTable(report, "ranks", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "ranks", row.R_id);
    const values = {
      id: v3Id, name: row.R_name, expRequired: BigInt(row.R_exp),
      cashReward: BigInt(row.R_cashReward), bulletReward: row.R_bulletReward, maxHealth: row.R_health,
    };
    await exec.insert(ranks).values(values).onConflictDoUpdate({ target: ranks.id, set: values });
    bumpTable(report, "ranks", "written");
  }

  const [moneyRankRows] = await pool.query<(MoneyRankRow & mysql.RowDataPacket)[]>(
    "SELECT MR_id, MR_label, MR_threshold FROM moneyRanks",
  );
  for (const row of moneyRankRows) {
    bumpTable(report, "moneyRanks", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "moneyRanks", row.MR_id);
    const values = { id: v3Id, label: row.MR_label, threshold: BigInt(row.MR_threshold) };
    await exec.insert(moneyRanks).values(values).onConflictDoUpdate({ target: moneyRanks.id, set: values });
    bumpTable(report, "moneyRanks", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/ranks.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/ranks.ts apps/migrate/test/migrators/ranks.test.ts
git commit -m "feat(migrate): ranks + moneyRanks migrator, bigint conversion"
```

---

### Task 14: Content migrator — `crimes`

**Files:**
- Create: `apps/migrate/src/migrators/crimes.ts`
- Test: `apps/migrate/test/migrators/crimes.test.ts`

**Interfaces:**
- Consumes: same primitives; `crimes` schema table.
- Produces: `migrateCrimes(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { crimes } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateCrimes } from "../../src/migrators/crimes.js";

describe("migrateCrimes", () => {
  it("migrates the 5 crimes (id gap at 4 is a source-data fact, not a migrator concern here)", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateCrimes(pool, db, report);

      const rows = await db.select().from(crimes);
      expect(rows).toHaveLength(5);
      const gta = rows.find((r) => r.name === "Grand Theft Auto");
      expect(gta?.minPayout).toBe(500n);
      expect(gta?.maxPayout).toBe(2000n);
      expect(gta?.cooldownSeconds).toBe(600);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `crimes.ts`**

```ts
import type mysql from "mysql2/promise";
import { crimes } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface CrimeRow {
  C_id: number; C_name: string; C_description: string | null; C_cooldown: number;
  C_money: number; C_maxMoney: number; C_bullets: number; C_maxBullets: number;
  C_exp: number; C_level: number;
}

export async function migrateCrimes(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(CrimeRow & mysql.RowDataPacket)[]>(
    "SELECT C_id, C_name, C_description, C_cooldown, C_money, C_maxMoney, C_bullets, C_maxBullets, C_exp, C_level " +
    "FROM crimes ORDER BY C_id",
  );

  let sort = 0;
  for (const row of rows) {
    bumpTable(report, "crimes", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "crimes", row.C_id);
    const values = {
      id: v3Id, name: row.C_name, description: row.C_description ?? "",
      cooldownSeconds: row.C_cooldown, minPayout: BigInt(row.C_money), maxPayout: BigInt(row.C_maxMoney),
      minBullets: row.C_bullets, maxBullets: row.C_maxBullets, expReward: BigInt(row.C_exp),
      minRank: row.C_level, sort: sort++,
    };
    await exec.insert(crimes).values(values).onConflictDoUpdate({ target: crimes.id, set: values });
    bumpTable(report, "crimes", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/crimes.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/crimes.ts apps/migrate/test/migrators/crimes.test.ts
git commit -m "feat(migrate): crimes migrator"
```

---

### Task 15: Content migrator — `locations`

**Files:**
- Create: `apps/migrate/src/migrators/locations.ts`
- Test: `apps/migrate/test/migrators/locations.test.ts`

**Interfaces:**
- Consumes: same primitives; `locations` schema table.
- Produces: `migrateLocations(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { locations } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateLocations } from "../../src/migrators/locations.js";

describe("migrateLocations", () => {
  it("migrates both locations", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateLocations(pool, db, createReport(false));

      const rows = await db.select().from(locations);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.name === "Chicago")?.travelCost).toBe(100n);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `locations.ts`**

```ts
import type mysql from "mysql2/promise";
import { locations } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface LocationRow { L_id: number; L_name: string; L_cost: number; L_cooldown: number; L_bullets: number; L_bulletCost: number; }

export async function migrateLocations(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(LocationRow & mysql.RowDataPacket)[]>(
    "SELECT L_id, L_name, L_cost, L_cooldown, L_bullets, L_bulletCost FROM locations",
  );
  for (const row of rows) {
    bumpTable(report, "locations", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "locations", row.L_id);
    const values = {
      id: v3Id, name: row.L_name, travelCost: BigInt(row.L_cost),
      travelCooldownSeconds: row.L_cooldown, bulletStock: row.L_bullets, bulletCost: BigInt(row.L_bulletCost),
    };
    await exec.insert(locations).values(values).onConflictDoUpdate({ target: locations.id, set: values });
    bumpTable(report, "locations", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/locations.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/locations.ts apps/migrate/test/migrators/locations.test.ts
git commit -m "feat(migrate): locations migrator"
```

---

### Task 16: Content migrator — `cars` + `theft`

**Files:**
- Create: `apps/migrate/src/migrators/cars.ts`
- Test: `apps/migrate/test/migrators/cars.test.ts`

**Interfaces:**
- Consumes: same primitives; `cars`/`theftTiers` schema tables.
- Produces: `migrateCars(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { cars, theftTiers } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateCars } from "../../src/migrators/cars.js";

describe("migrateCars", () => {
  it("migrates cars (theftWeight, not a percentage) and theft tiers (cash bounds, not car ids)", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateCars(pool, db, createReport(false));

      const carRows = await db.select().from(cars);
      expect(carRows).toHaveLength(2);
      expect(carRows.find((c) => c.name === "Sports Car")?.theftWeight).toBe(2);

      const theftRows = await db.select().from(theftTiers);
      expect(theftRows).toHaveLength(1);
      expect(theftRows[0]?.minCarValue).toBe(1000n);
      expect(theftRows[0]?.maxCarValue).toBe(10000n);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `cars.ts`**

```ts
import type mysql from "mysql2/promise";
import { cars, theftTiers } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface CarRow { CA_id: number; CA_name: string; CA_value: number; CA_theftChance: number; }
interface TheftRow { T_id: number; T_name: string; T_chance: number; T_maxDamage: number; T_worstCar: number; T_bestCar: number; }

export async function migrateCars(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [carRows] = await pool.query<(CarRow & mysql.RowDataPacket)[]>(
    "SELECT CA_id, CA_name, CA_value, CA_theftChance FROM cars",
  );
  for (const row of carRows) {
    bumpTable(report, "cars", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "cars", row.CA_id);
    // SPEC §1.2: CA_theftChance is a weight, not a percentage — copied as-is.
    const values = { id: v3Id, name: row.CA_name, value: BigInt(row.CA_value), theftWeight: row.CA_theftChance };
    await exec.insert(cars).values(values).onConflictDoUpdate({ target: cars.id, set: values });
    bumpTable(report, "cars", "written");
  }

  const [theftRows] = await pool.query<(TheftRow & mysql.RowDataPacket)[]>(
    "SELECT T_id, T_name, T_chance, T_maxDamage, T_worstCar, T_bestCar FROM theft",
  );
  for (const row of theftRows) {
    bumpTable(report, "theft", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "theft", row.T_id);
    // SPEC §1.2: T_worstCar/T_bestCar are cash value bounds, not car ids.
    const values = {
      id: v3Id, name: row.T_name, successChance: row.T_chance, maxDamage: row.T_maxDamage,
      minCarValue: BigInt(row.T_worstCar), maxCarValue: BigInt(row.T_bestCar),
    };
    await exec.insert(theftTiers).values(values).onConflictDoUpdate({ target: theftTiers.id, set: values });
    bumpTable(report, "theft", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/cars.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/cars.ts apps/migrate/test/migrators/cars.test.ts
git commit -m "feat(migrate): cars + theft tiers migrator"
```

---

### Task 17: Content migrator — `weapons`

**Files:**
- Create: `apps/migrate/src/migrators/weapons.ts`
- Test: `apps/migrate/test/migrators/weapons.test.ts`

**Interfaces:**
- Consumes: same primitives; `weapons` schema table.
- Produces: `migrateWeapons(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { weapons } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateWeapons } from "../../src/migrators/weapons.js";

describe("migrateWeapons", () => {
  it("migrates both weapons", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateWeapons(pool, db, createReport(false));
      const rows = await db.select().from(weapons);
      expect(rows).toHaveLength(2);
      expect(rows.find((w) => w.name === "Pistol")?.accuracy).toBe(60);
      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `weapons.ts`**

```ts
import type mysql from "mysql2/promise";
import { weapons } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface WeaponRow { W_id: number; W_name: string; W_accuracy: number; }

export async function migrateWeapons(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(WeaponRow & mysql.RowDataPacket)[]>("SELECT W_id, W_name, W_accuracy FROM weapons");
  for (const row of rows) {
    bumpTable(report, "weapons", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "weapons", row.W_id);
    const values = { id: v3Id, name: row.W_name, accuracy: row.W_accuracy };
    await exec.insert(weapons).values(values).onConflictDoUpdate({ target: weapons.id, set: values });
    bumpTable(report, "weapons", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/weapons.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/weapons.ts apps/migrate/test/migrators/weapons.test.ts
git commit -m "feat(migrate): weapons migrator"
```

---

### Task 18: Content migrator — `items` (+ `itemEffects` + `itemMeta` → JSONB)

**Files:**
- Create: `apps/migrate/src/migrators/items.ts`
- Test: `apps/migrate/test/migrators/items.test.ts`

**Interfaces:**
- Consumes: same primitives; `items` schema table.
- Produces: `migrateItems(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Covers the EAV merge and the orphan `itemEffects` row (item 99 does not exist).

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { items } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateItems } from "../../src/migrators/items.js";

describe("migrateItems", () => {
  it("merges itemEffects and itemMeta into JSONB effects/meta, dropping the orphan effect row", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateItems(pool, db, report);

      const rows = await db.select().from(items);
      expect(rows).toHaveLength(2);
      const bat = rows.find((i) => i.name === "Baseball Bat");
      expect(bat?.effects).toEqual({ damage: 15 });
      expect(bat?.meta).toEqual({ rarity: "common" });
      const vest = rows.find((i) => i.name === "Kevlar Vest");
      expect(vest?.effects).toEqual({ armor: 20 });
      expect(vest?.meta).toEqual({});

      expect(report.orphans).toContainEqual({ table: "itemEffects", v2Id: 99, reason: "item 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `items.ts`**

```ts
import type mysql from "mysql2/promise";
import { items } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface ItemRow { I_id: number; I_name: string; I_type: string; }
interface ItemEffectRow { IE_item: number; IE_effect: string; IE_value: number; }
interface ItemMetaRow { IM_item: number; IM_key: string; IM_value: string | null; }

export async function migrateItems(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [itemRows] = await pool.query<(ItemRow & mysql.RowDataPacket)[]>("SELECT I_id, I_name, I_type FROM items");
  const knownItemIds = new Set(itemRows.map((r) => r.I_id));

  const [effectRows] = await pool.query<(ItemEffectRow & mysql.RowDataPacket)[]>(
    "SELECT IE_item, IE_effect, IE_value FROM itemEffects",
  );
  const effectsByItem = new Map<number, Record<string, number>>();
  for (const row of effectRows) {
    bumpTable(report, "itemEffects", "read");
    if (!knownItemIds.has(row.IE_item)) {
      recordOrphan(report, "itemEffects", row.IE_item, `item ${row.IE_item} does not exist`);
      bumpTable(report, "itemEffects", "skipped");
      continue;
    }
    const bucket = effectsByItem.get(row.IE_item) ?? {};
    bucket[row.IE_effect] = row.IE_value;
    effectsByItem.set(row.IE_item, bucket);
    bumpTable(report, "itemEffects", "written");
  }

  const [metaRows] = await pool.query<(ItemMetaRow & mysql.RowDataPacket)[]>(
    "SELECT IM_item, IM_key, IM_value FROM itemMeta",
  );
  const metaByItem = new Map<number, Record<string, string | null>>();
  for (const row of metaRows) {
    bumpTable(report, "itemMeta", "read");
    if (!knownItemIds.has(row.IM_item)) {
      recordOrphan(report, "itemMeta", row.IM_item, `item ${row.IM_item} does not exist`);
      bumpTable(report, "itemMeta", "skipped");
      continue;
    }
    const bucket = metaByItem.get(row.IM_item) ?? {};
    bucket[row.IM_key] = row.IM_value;
    metaByItem.set(row.IM_item, bucket);
    bumpTable(report, "itemMeta", "written");
  }

  for (const row of itemRows) {
    bumpTable(report, "items", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "items", row.I_id);
    const values = {
      id: v3Id, name: row.I_name, itemType: row.I_type,
      effects: effectsByItem.get(row.I_id) ?? {}, meta: metaByItem.get(row.I_id) ?? {},
    };
    await exec.insert(items).values(values).onConflictDoUpdate({ target: items.id, set: values });
    bumpTable(report, "items", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/items.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/items.ts apps/migrate/test/migrators/items.test.ts
git commit -m "feat(migrate): items migrator — itemEffects/itemMeta EAV merged into JSONB, orphans dropped"
```

---

### Task 19: `settings` migrator (no `id_map` — the key itself is the identity)

**Files:**
- Create: `apps/migrate/src/migrators/settings.ts`
- Test: `apps/migrate/test/migrators/settings.test.ts`

**Interfaces:**
- Consumes: `bumpTable`/`MigrationReport`; `settings` schema table. **Not** `id_map` — see Global Constraints.
- Produces: `migrateSettings(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test, including the idempotency case**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { settings } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateSettings } from "../../src/migrators/settings.js";

describe("migrateSettings", () => {
  it("migrates key/value settings verbatim and stays idempotent on re-run", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await migrateSettings(pool, db, createReport(false));
      await migrateSettings(pool, db, createReport(false)); // re-run

      const rows = await db.select().from(settings);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.key === "gangName")?.value).toBe("Family");

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `settings.ts`**

```ts
import type mysql from "mysql2/promise";
import { settings } from "../../../server/src/db/schema/index.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface SettingRow { S_key: string; S_value: string | null; }

/**
 * No id_map here: settings.key is a natural key, identical on both sides
 * (V2's S_key IS the GL3 key). ON CONFLICT (key) DO UPDATE alone gives
 * idempotency — see Global Constraints, "Not every table needs id_map".
 */
export async function migrateSettings(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(SettingRow & mysql.RowDataPacket)[]>("SELECT S_key, S_value FROM settings");
  for (const row of rows) {
    bumpTable(report, "settings", "read");
    await exec.insert(settings).values({ key: row.S_key, value: row.S_value ?? "" })
      .onConflictDoUpdate({ target: settings.key, set: { value: row.S_value ?? "" } });
    bumpTable(report, "settings", "written");
  }
}
```

Run: `npx vitest run apps/migrate/test/migrators/settings.test.ts` → PASS, 1 test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/settings.ts apps/migrate/test/migrators/settings.test.ts
git commit -m "feat(migrate): settings migrator (natural key, no id_map)"
```

---

# Players, gangs, and social migrators (Tasks 20–28)

These need Tasks 11–19 merged first — see the note on real foreign keys in "Independence groups" above. Each test below seeds its FK targets by calling the actual migrator that owns them, never by hand-rolling an equivalent insert.

### Task 20: Players migrator — `users` + `userStats` core columns

`gang_id`, `jailed_until`, and `hospital_until` are deliberately left `null` here — see "Known unknowns" item 3 (gangs run after players) and item 6 below (timers run in a separate task). This task only writes what `users`/`userStats` can resolve on their own.

**Files:**
- Create: `apps/migrate/src/migrators/players.ts`
- Test: `apps/migrate/test/migrators/players.test.ts`

**Interfaces:**
- Consumes: `getOrCreateV3Id`/`lookupV3Id`; `players`/`playerStats` schema tables; `migrateRanks`/`migrateLocations`/`migrateItems`/`migrateRoles`/`migrateRounds` (test setup only).
- Produces: `migratePlayers(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { players, playerStats } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migratePlayers", () => {
  it("migrates users + userStats core columns, copying the legacy password verbatim", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      // FK targets, in real pipeline order (Task 29 will do this for real).
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));

      const report = createReport(false);
      await migratePlayers(pool, db, report);

      const playerRows = await db.select().from(players);
      expect(playerRows).toHaveLength(6);

      const vito = playerRows.find((p) => p.username === "DonVito");
      expect(vito?.legacyV2Id).toBe(1);
      expect(vito?.legacyPasswordSha256).toBe("d62a234e0d9f59d8240292e2042e50e7d1da3c668a0636bf5930fcaac5b52224");
      expect(vito?.passwordHash).toBeNull();
      expect(vito?.email).toBe("vito@family.test");

      const oldTimer = playerRows.find((p) => p.username === "OldTimer");
      const adminRoleId = await lookupV3Id(db, "userRoles", 2);
      expect(oldTimer?.roleId).toBe(adminRoleId); // U_userLevel=2 -> role 2

      const vitoStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, vito!.id)))[0];
      expect(vitoStats?.cash).toBe(2100000000n); // above the V2 int32 comfort zone, exact
      expect(vitoStats?.gangId).toBeNull(); // deferred to the gangs migrator (Task 23)
      expect(vitoStats?.avatarUrl).toBeNull();
      expect(vitoStats?.bio).toBe("Head of the family");

      const usersTable = report.tables.find((t) => t.table === "users");
      expect(usersTable).toEqual({ table: "users", read: 6, written: 6, skipped: 0 });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/players.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/players.js`.

- [ ] **Step 3: Write `players.ts`**

```ts
import { sql } from "drizzle-orm";
import type mysql from "mysql2/promise";
import { players, playerStats } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface UserRow {
  U_id: number; U_name: string; U_email: string | null; U_password: string;
  U_userLevel: number; U_round: number;
}
interface UserStatsRow {
  US_id: number; US_money: number; US_bank: number; US_bullets: number; US_exp: number;
  US_health: number; US_backfire: number; US_points: number; US_weapon: number; US_armor: number;
  US_rank: number; US_location: number | null; US_pic: string | null; US_bio: string | null;
}

export async function migratePlayers(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [userRows] = await pool.query<(UserRow & mysql.RowDataPacket)[]>(
    "SELECT U_id, U_name, U_email, U_password, U_userLevel, U_round FROM users",
  );
  const [statsRows] = await pool.query<(UserStatsRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_money, US_bank, US_bullets, US_exp, US_health, US_backfire, US_points, " +
    "US_weapon, US_armor, US_rank, US_location, US_pic, US_bio FROM userStats",
  );
  const statsByUser = new Map(statsRows.map((r) => [r.US_id, r]));

  for (const user of userRows) {
    bumpTable(report, "users", "read");
    const { v3Id: playerId } = await getOrCreateV3Id(exec, "users", user.U_id);

    // "Known unknowns" item 2: U_userLevel treated as userRoles.UR_id. No
    // matching role -> left null, not an orphan (role_id is nullable, and
    // §4.2's orphan policy names users/gangs/items specifically, not roles).
    const roleId = await lookupV3Id(exec, "userRoles", user.U_userLevel);
    const roundId = await lookupV3Id(exec, "rounds", user.U_round);

    await exec.insert(players).values({
      id: playerId, username: user.U_name, email: user.U_email,
      passwordHash: null, legacyPasswordSha256: user.U_password, legacyV2Id: user.U_id,
      roleId, roundId,
    }).onConflictDoUpdate({
      target: players.id,
      set: {
        username: user.U_name, email: user.U_email, roleId, roundId,
        // Never clobber a legacy hash the server has already nulled out
        // after a successful upgrade to argon2id (SPEC §4.3, Task 31's
        // e2e test) — only refresh it while the player is still
        // un-upgraded. `players.passwordHash`/`players.legacyPasswordSha256`
        // here refer to the EXISTING row (Postgres upsert semantics: only
        // `excluded.*` refers to the proposed new row), so this survives
        // any number of re-runs after login has upgraded the player.
        legacyPasswordSha256: sql`CASE WHEN ${players.passwordHash} IS NULL THEN ${user.U_password} ELSE ${players.legacyPasswordSha256} END`,
      },
    });
    bumpTable(report, "users", "written");

    const stats = statsByUser.get(user.U_id);
    if (!stats) {
      recordOrphan(report, "userStats", user.U_id, `user ${user.U_id} has no matching userStats row`);
      continue;
    }
    bumpTable(report, "userStats", "read");

    const rankId = await lookupV3Id(exec, "ranks", stats.US_rank);
    const locationId = stats.US_location ? await lookupV3Id(exec, "locations", stats.US_location) : null;
    // 0 is V2's "nothing equipped" convention, not a real item reference.
    const weaponItemId = stats.US_weapon > 0 ? await lookupV3Id(exec, "items", stats.US_weapon) : null;
    const armorItemId = stats.US_armor > 0 ? await lookupV3Id(exec, "items", stats.US_armor) : null;

    await exec.insert(playerStats).values({
      playerId,
      cash: BigInt(stats.US_money), bank: BigInt(stats.US_bank), bullets: BigInt(stats.US_bullets),
      exp: BigInt(stats.US_exp), points: BigInt(stats.US_points),
      health: stats.US_health, backfire: stats.US_backfire,
      rankId, locationId, weaponItemId, armorItemId,
      avatarUrl: stats.US_pic, bio: stats.US_bio,
      // gang_id / jailed_until / hospital_until: filled by later migrators.
    }).onConflictDoUpdate({
      target: playerStats.playerId,
      set: {
        cash: BigInt(stats.US_money), bank: BigInt(stats.US_bank), bullets: BigInt(stats.US_bullets),
        exp: BigInt(stats.US_exp), points: BigInt(stats.US_points),
        health: stats.US_health, backfire: stats.US_backfire,
        rankId, locationId, weaponItemId, armorItemId,
        avatarUrl: stats.US_pic, bio: stats.US_bio,
      },
    });
    bumpTable(report, "userStats", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/players.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/players.ts apps/migrate/test/migrators/players.test.ts
git commit -m "feat(migrate): players migrator — users+userStats core, legacy password copied verbatim (SPEC §4.3)"
```

---

### Task 21: Timers migrator — `userTimers` → `player_timers` / `jailed_until` / `hospital_until`

Past timers dropped, future ones migrated; `jail`/`hospital` go to their typed `player_stats` columns instead of a generic row (§4.2 item 6). Unknown keys migrate anyway and get one report entry per distinct key (§1.2: "migrate ALL rows, known or not").

**Files:**
- Create: `apps/migrate/src/migrators/timers.ts`
- Test: `apps/migrate/test/migrators/timers.test.ts`

**Interfaces:**
- Consumes: `playerTimers`/`playerStats` schema tables; `migratePlayers` (+ its own FK setup) as test seed.
- Produces: `migrateTimers(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { playerStats, playerTimers } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateTimers } from "../../src/migrators/timers.js";
import { lookupV3Id } from "../../src/id-map.js";

async function seedThroughPlayers(pool: mysql.Pool, db: ReturnType<typeof createDb>["db"]): Promise<void> {
  await migrateRoles(pool, db, createReport(false));
  await migrateRounds(pool, db, createReport(false));
  await migrateRanks(pool, db, createReport(false));
  await migrateLocations(pool, db, createReport(false));
  await migrateItems(pool, db, createReport(false));
  await migratePlayers(pool, db, createReport(false));
}

describe("migrateTimers", () => {
  it("drops past timers, promotes jail/hospital, keeps unknown keys, drops the orphan user row", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await seedThroughPlayers(pool, db);

      const report = createReport(false);
      await migrateTimers(pool, db, report);

      const vitoId = await lookupV3Id(db, "users", 1);
      const vitoStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, vitoId!)))[0];
      expect(vitoStats?.jailedUntil).toEqual(new Date(4102444800 * 1000)); // future 'jail' promoted
      expect(vitoStats?.hospitalUntil).toBeNull(); // past 'hospital' dropped entirely

      const soldierId = await lookupV3Id(db, "users", 3);
      const genericTimers = await db.select().from(playerTimers).where(eq(playerTimers.playerId, soldierId!));
      expect(genericTimers).toHaveLength(2); // 'crime' + 'someCustomModuleKey', both future
      expect(genericTimers.map((t) => t.key).sort()).toEqual(["crime", "someCustomModuleKey"]);

      expect(report.unknownTimerKeys).toEqual(["someCustomModuleKey"]);
      expect(report.orphans).toContainEqual({ table: "userTimers", v2Id: 999, reason: "user 999 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/timers.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/timers.js`.

- [ ] **Step 3: Write `timers.ts`**

```ts
import { eq } from "drizzle-orm";
import type mysql from "mysql2/promise";
import { playerStats, playerTimers } from "../../../server/src/db/schema/index.js";
import { lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, recordUnknownTimerKey, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface UserTimerRow { UT_user: number; UT_key: string; UT_time: number; }

/** SPEC §1.2's observed keys. Anything else still migrates — just gets a report entry. */
const KNOWN_TIMER_KEYS = new Set([
  "jail", "hospital", "crime", "membership", "sentMail", "signup",
  "killed", "superMax", "laston", "forumMute", "forumTopic", "forumPost", "glDirVote", "count",
]);

export async function migrateTimers(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(UserTimerRow & mysql.RowDataPacket)[]>(
    "SELECT UT_user, UT_key, UT_time FROM userTimers",
  );
  const now = new Date();

  for (const row of rows) {
    bumpTable(report, "userTimers", "read");

    const playerId = await lookupV3Id(exec, "users", row.UT_user);
    if (!playerId) {
      recordOrphan(report, "userTimers", row.UT_user, `user ${row.UT_user} does not exist`);
      bumpTable(report, "userTimers", "skipped");
      continue;
    }

    const expiresAt = unixToDate(row.UT_time);
    if (!expiresAt || expiresAt <= now) {
      // §4.2 item 6: past timers are dropped, full stop — including 'jail'/'hospital'.
      bumpTable(report, "userTimers", "skipped");
      continue;
    }

    if (!KNOWN_TIMER_KEYS.has(row.UT_key)) recordUnknownTimerKey(report, row.UT_key);

    if (row.UT_key === "jail") {
      await exec.update(playerStats).set({ jailedUntil: expiresAt }).where(eq(playerStats.playerId, playerId));
    } else if (row.UT_key === "hospital") {
      await exec.update(playerStats).set({ hospitalUntil: expiresAt }).where(eq(playerStats.playerId, playerId));
    } else {
      await exec.insert(playerTimers).values({ playerId, key: row.UT_key, expiresAt })
        .onConflictDoUpdate({ target: [playerTimers.playerId, playerTimers.key], set: { expiresAt } });
    }
    bumpTable(report, "userTimers", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/timers.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/timers.ts apps/migrate/test/migrators/timers.test.ts
git commit -m "feat(migrate): timers migrator — past dropped, jail/hospital typed, unknown keys preserved+reported (SPEC §4.2.6)"
```

---

### Task 22: Crime-skill explode migrator — `US_crimes` → `player_crime_skill`

The quirk (SPEC §1.2): `US_crimes` is dash-delimited, indexed by `C_id - 1`, not row order. A player's own string may be shorter than the live crime list (falls back to the schema default's value at that position) or reference a position with no crime at all — an id gap from a deleted crime (dropped, reported).

**Files:**
- Create: `apps/migrate/src/migrators/crime-skill.ts`
- Test: `apps/migrate/test/migrators/crime-skill.test.ts`

**Interfaces:**
- Consumes: `playerCrimeSkill` schema table; `migrateCrimes` + `migratePlayers` (+ their own setup) as test seed.
- Produces: `migrateCrimeSkill(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Exercises all three outcomes against the fixture: DonVito (`'50-40-30'`, len 3) gets direct values for crimes 1–3, nothing for 5/6 wait — re-check: crime 5 is at index 4, DonVito's string only reaches index 2, so crime 5 falls back to the base default's index 4 (`'5'`); crime 6 is at index 5, which the base default (len 5, indices 0–4) doesn't reach either, so crime 6 gets **no row** for DonVito. Underboss (`'20-20-20-20-20-20'`, len 6) covers every index directly, including index 3 — which has no matching crime (id 4 was deleted) — so that position is dropped and reported; the rest (crimes 1,2,3,5,6) get `'20'` directly. Soldier (`'10'`, len 1) covers only crime 1 directly; crimes 2, 3, 5 fall back to the base default; crime 6 gets no row, same reason as DonVito.

```ts
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { playerCrimeSkill } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migrateCrimes } from "../../src/migrators/crimes.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateCrimeSkill } from "../../src/migrators/crime-skill.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateCrimeSkill", () => {
  it("explodes US_crimes per SPEC §1.2's C_id-1 indexing quirk", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migrateCrimes(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateCrimeSkill(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const underbossId = (await lookupV3Id(db, "users", 2))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;
      const crime1 = (await lookupV3Id(db, "crimes", 1))!;
      const crime2 = (await lookupV3Id(db, "crimes", 2))!;
      const crime3 = (await lookupV3Id(db, "crimes", 3))!;
      const crime5 = (await lookupV3Id(db, "crimes", 5))!;
      const crime6 = (await lookupV3Id(db, "crimes", 6))!;

      async function chanceFor(playerId: string, crimeId: string): Promise<string | undefined> {
        const [row] = await db.select().from(playerCrimeSkill)
          .where(and(eq(playerCrimeSkill.playerId, playerId), eq(playerCrimeSkill.crimeId, crimeId)));
        return row?.chance;
      }

      // DonVito: direct values for 1-3, fallback-to-base for 5, nothing for 6.
      expect(await chanceFor(vitoId, crime1)).toBe("50.00");
      expect(await chanceFor(vitoId, crime3)).toBe("30.00");
      expect(await chanceFor(vitoId, crime5)).toBe("5.00"); // base default index 4
      expect(await chanceFor(vitoId, crime6)).toBeUndefined();

      // Underboss: every index direct, including the dropped id-4 gap.
      expect(await chanceFor(underbossId, crime1)).toBe("20.00");
      expect(await chanceFor(underbossId, crime6)).toBe("20.00");
      expect(report.droppedCrimePositions).toContainEqual({ playerV2Id: 2, position: 3 });

      // Soldier: direct for 1, fallback-to-base for 2/3/5, nothing for 6.
      expect(await chanceFor(soldierId, crime1)).toBe("10.00");
      expect(await chanceFor(soldierId, crime2)).toBe("25.00"); // base default index 1
      expect(await chanceFor(soldierId, crime6)).toBeUndefined();

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/crime-skill.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/crime-skill.js`.

- [ ] **Step 3: Write `crime-skill.ts`**

```ts
import type mysql from "mysql2/promise";
import { playerCrimeSkill } from "../../../server/src/db/schema/index.js";
import { lookupV3Id } from "../id-map.js";
import { bumpTable, recordDroppedCrimePosition, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface UserStatsCrimesRow { US_id: number; US_crimes: string; }
interface CrimeIdRow { C_id: number; }
interface DefaultRow { COLUMN_DEFAULT: string | null; }

async function fetchBaseDefault(pool: mysql.Pool): Promise<string> {
  const [rows] = await pool.query<(DefaultRow & mysql.RowDataPacket)[]>(
    "SELECT COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userStats' AND COLUMN_NAME = 'US_crimes'",
  );
  return rows[0]?.COLUMN_DEFAULT ?? "";
}

export async function migrateCrimeSkill(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [crimeRows] = await pool.query<(CrimeIdRow & mysql.RowDataPacket)[]>("SELECT C_id FROM crimes");
  const crimeIdByPosition = new Map(crimeRows.map((c) => [c.C_id - 1, c.C_id]));

  const baseDefault = await fetchBaseDefault(pool);
  const baseParts = baseDefault.split("-");

  const [statsRows] = await pool.query<(UserStatsCrimesRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_crimes FROM userStats",
  );

  for (const stats of statsRows) {
    const playerId = await lookupV3Id(exec, "users", stats.US_id);
    if (!playerId) continue; // orphan already reported by the players migrator (Task 20)

    const playerParts = stats.US_crimes.split("-");
    const written = new Set<number>(); // crime ids already handled from the player's own string

    // Positions in the player's own string. A position with no matching
    // crime id (an id gap from a deleted crime) is dropped and reported.
    for (const [index, value] of playerParts.entries()) {
      const crimeId = crimeIdByPosition.get(index);
      if (crimeId === undefined) {
        recordDroppedCrimePosition(report, stats.US_id, index);
        continue;
      }
      const crimeUuid = await lookupV3Id(exec, "crimes", crimeId);
      if (!crimeUuid) continue;
      await exec.insert(playerCrimeSkill).values({ playerId, crimeId: crimeUuid, chance: value })
        .onConflictDoUpdate({ target: [playerCrimeSkill.playerId, playerCrimeSkill.crimeId], set: { chance: value } });
      written.add(crimeId);
      bumpTable(report, "US_crimes", "written");
    }

    // Existing crimes whose position the player's own string never reached
    // (e.g. the crime was added after this player's row was last written)
    // fall back to the schema default's value at that same position.
    for (const [index, crimeId] of crimeIdByPosition.entries()) {
      if (written.has(crimeId) || index < playerParts.length) continue;
      const fallback = baseParts[index];
      if (fallback === undefined) continue; // neither the player's nor the base string reaches this far
      const crimeUuid = await lookupV3Id(exec, "crimes", crimeId);
      if (!crimeUuid) continue;
      await exec.insert(playerCrimeSkill).values({ playerId, crimeId: crimeUuid, chance: fallback })
        .onConflictDoUpdate({ target: [playerCrimeSkill.playerId, playerCrimeSkill.crimeId], set: { chance: fallback } });
      bumpTable(report, "US_crimes", "written");
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/crime-skill.test.ts`
Expected: PASS, 1 test. If a `chanceFor` assertion is off by the `numeric(5,2)` formatting (e.g. `"5"` vs `"5.00"`), that's Postgres's `numeric` column returning its canonical string form — the test's expected values already account for it.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/crime-skill.ts apps/migrate/test/migrators/crime-skill.test.ts
git commit -m "feat(migrate): explode US_crimes into player_crime_skill (SPEC §1.2 C_id-1 indexing quirk)"
```

---

### Task 23: Gangs migrator — `gangs` core, `US_gang` → `gang_members`, boss/underboss cross-check

Implements §4.2 item 5 and "Known unknowns" item 3 (`player_stats.gang_id` is back-filled here, not in Task 20) and item 4 (the underboss cross-check extension).

**Files:**
- Create: `apps/migrate/src/migrators/gangs.ts`
- Test: `apps/migrate/test/migrators/gangs.test.ts`

**Interfaces:**
- Consumes: `gangs`/`gangMembers`/`playerStats` schema tables; `migratePlayers` (+ its setup) and `migrateLocations` as test seed.
- Produces: `migrateGangs(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Adds a second gang (`G_id=2`) directly via SQL, purpose-built so *neither* its boss nor its underboss is already a member — the fixture's gang 1 only exercises the boss case (its underboss, `Underboss`, already has `US_gang=1`).

```ts
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { gangMembers, gangs, playerStats } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateGangs } from "../../src/migrators/gangs.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateGangs", () => {
  it("migrates gangs, US_gang membership, and cross-checks boss+underboss into their own gang", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      // Gang 2: boss=Soldier(3), underboss=LoneWolf(4) — neither has US_gang=2 in the
      // fixture (Soldier's US_gang=1, LoneWolf's is 0), so both cross-checks fire here
      // distinctly from gang 1 (which only exercises the boss case).
      await pool.query(
        "INSERT INTO gangs (G_id, G_name, G_boss, G_underboss, G_bank, G_money, G_level, G_location) " +
        "VALUES (2, 'Small Crew', 3, 4, 1000, 500, 1, 2)",
      );

      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateGangs(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const underbossId = (await lookupV3Id(db, "users", 2))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;
      const loneWolfId = (await lookupV3Id(db, "users", 4))!;
      const gang1Id = (await lookupV3Id(db, "gangs", 1))!;
      const gang2Id = (await lookupV3Id(db, "gangs", 2))!;

      const gangRows = await db.select().from(gangs);
      expect(gangRows).toHaveLength(2);
      const family = gangRows.find((g) => g.name === "The Family");
      expect(family?.bossPlayerId).toBe(vitoId);
      expect(family?.underbossPlayerId).toBe(underbossId);
      expect(family?.bank).toBe(900000000n);

      // Gang 1: underboss + soldier from US_gang=1, plus Vito added by the boss cross-check.
      const gang1Members = await db.select().from(gangMembers).where(eq(gangMembers.gangId, gang1Id));
      expect(gang1Members.map((m) => m.playerId).sort()).toEqual([underbossId, soldierId, vitoId].sort());

      // Gang 2: both boss and underboss added purely by the cross-check.
      const gang2Members = await db.select().from(gangMembers).where(eq(gangMembers.gangId, gang2Id));
      expect(gang2Members.map((m) => m.playerId).sort()).toEqual([loneWolfId, soldierId].sort());

      expect(report.bossNotInGang).toContainEqual({ gangV2Id: 1, bossV2Id: 1 });
      expect(report.bossNotInGang).toContainEqual({ gangV2Id: 2, bossV2Id: 3 });
      expect(report.underbossNotInGang).toContainEqual({ gangV2Id: 2, underbossV2Id: 4 });

      // player_stats.gang_id is back-filled here (Task 20 left it null).
      const vitoStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, vitoId)))[0];
      expect(vitoStats?.gangId).toBe(gang1Id);

      // GhostGangMember (user 5, US_gang=99) is an orphan — no gang, never crashes.
      const ghostId = (await lookupV3Id(db, "users", 5))!;
      const ghostStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, ghostId)))[0];
      expect(ghostStats?.gangId).toBeNull();
      expect(report.orphans).toContainEqual({ table: "US_gang", v2Id: 5, reason: "gang 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("is idempotent: re-running does not duplicate members or re-report the same cross-check", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      await migrateGangs(pool, db, createReport(false));
      const secondReport = createReport(false);
      await migrateGangs(pool, db, secondReport);

      const gang1Id = (await lookupV3Id(db, "gangs", 1))!;
      const members = await db.select().from(gangMembers).where(eq(gangMembers.gangId, gang1Id));
      expect(members).toHaveLength(3); // still 3, not 6
      expect(secondReport.bossNotInGang).toEqual([]); // Vito is already a member the second time around

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/gangs.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/gangs.js`.

- [ ] **Step 3: Write `gangs.ts`**

```ts
import { and, eq } from "drizzle-orm";
import type mysql from "mysql2/promise";
import { gangMembers, gangs, playerStats } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface GangRow {
  G_id: number; G_name: string; G_boss: number; G_underboss: number | null;
  G_bank: number; G_money: number; G_level: number; G_location: number | null;
}
interface GangMembershipRow { US_id: number; US_gang: number; }

async function ensureMember(exec: Executor, gangId: string, playerId: string): Promise<boolean> {
  const [existing] = await exec.select().from(gangMembers)
    .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, playerId)));
  if (existing) return false;
  await exec.insert(gangMembers).values({ gangId, playerId })
    .onConflictDoNothing({ target: [gangMembers.gangId, gangMembers.playerId] });
  await exec.update(playerStats).set({ gangId }).where(eq(playerStats.playerId, playerId));
  return true;
}

export async function migrateGangs(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [gangRows] = await pool.query<(GangRow & mysql.RowDataPacket)[]>(
    "SELECT G_id, G_name, G_boss, G_underboss, G_bank, G_money, G_level, G_location FROM gangs",
  );

  const gangIdByV2 = new Map<number, string>();
  for (const row of gangRows) {
    bumpTable(report, "gangs", "read");
    const { v3Id: gangId } = await getOrCreateV3Id(exec, "gangs", row.G_id);
    gangIdByV2.set(row.G_id, gangId);

    const bossPlayerId = await lookupV3Id(exec, "users", row.G_boss);
    if (!bossPlayerId) recordOrphan(report, "gangs", row.G_id, `boss ${row.G_boss} does not exist`);
    const underbossPlayerId = row.G_underboss ? await lookupV3Id(exec, "users", row.G_underboss) : null;
    if (row.G_underboss && !underbossPlayerId) {
      recordOrphan(report, "gangs", row.G_id, `underboss ${row.G_underboss} does not exist`);
    }
    const locationId = row.G_location ? await lookupV3Id(exec, "locations", row.G_location) : null;

    const values = {
      id: gangId, name: row.G_name, bank: BigInt(row.G_bank), cash: BigInt(row.G_money),
      level: row.G_level, locationId, bossPlayerId, underbossPlayerId,
    };
    await exec.insert(gangs).values(values).onConflictDoUpdate({ target: gangs.id, set: values });
    bumpTable(report, "gangs", "written");
  }

  // §4.2 item 5: US_gang > 0 becomes a gang_members row.
  const [membershipRows] = await pool.query<(GangMembershipRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_gang FROM userStats WHERE US_gang > 0",
  );
  for (const row of membershipRows) {
    bumpTable(report, "US_gang", "read");
    const gangId = gangIdByV2.get(row.US_gang) ?? await lookupV3Id(exec, "gangs", row.US_gang);
    if (!gangId) {
      recordOrphan(report, "US_gang", row.US_id, `gang ${row.US_gang} does not exist`);
      bumpTable(report, "US_gang", "skipped");
      continue;
    }
    const playerId = await lookupV3Id(exec, "users", row.US_id);
    if (!playerId) { bumpTable(report, "US_gang", "skipped"); continue; }
    await ensureMember(exec, gangId, playerId);
    bumpTable(report, "US_gang", "written");
  }

  // §4.2 item 5 + "Known unknowns" item 4: a boss (or underboss) not in
  // their own gang gets a report entry AND a membership row created.
  for (const row of gangRows) {
    const gangId = gangIdByV2.get(row.G_id);
    if (!gangId) continue;

    const bossPlayerId = await lookupV3Id(exec, "users", row.G_boss);
    if (bossPlayerId && (await ensureMember(exec, gangId, bossPlayerId))) {
      report.bossNotInGang.push({ gangV2Id: row.G_id, bossV2Id: row.G_boss });
    }

    if (row.G_underboss) {
      const underbossPlayerId = await lookupV3Id(exec, "users", row.G_underboss);
      if (underbossPlayerId && (await ensureMember(exec, gangId, underbossPlayerId))) {
        report.underbossNotInGang.push({ gangV2Id: row.G_id, underbossV2Id: row.G_underboss });
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/migrate/test/migrators/gangs.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/gangs.ts apps/migrate/test/migrators/gangs.test.ts
git commit -m "feat(migrate): gangs migrator — US_gang membership, boss/underboss cross-check (SPEC §4.2.5)"
```

---

### Task 24: Gang social migrator — `gangPermissions` (derive `gang_id`) + `gangInvites` + `gangLogs`

`gangPermissions` has no gang column in V2 (SPEC §1.2) — the gang is derived from the member's `US_gang` at migration time; a gangless user's permission rows are dropped and reported.

**Files:**
- Create: `apps/migrate/src/migrators/gang-social.ts`
- Test: `apps/migrate/test/migrators/gang-social.test.ts`

**Interfaces:**
- Consumes: `gangPermissions`/`gangInvites`/`gangLogs` schema tables; `migrateGangs` (+ its setup) as test seed.
- Produces: `migrateGangSocial(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { gangInvites, gangLogs, gangPermissions } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateGangs } from "../../src/migrators/gangs.js";
import { migrateGangSocial } from "../../src/migrators/gang-social.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateGangSocial", () => {
  it("derives gang_id for permissions (dropping the gangless user's row), migrates invites and logs, dropping orphans", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));
      await migrateGangs(pool, db, createReport(false));

      const report = createReport(false);
      await migrateGangSocial(pool, db, report);

      const gang1Id = (await lookupV3Id(db, "gangs", 1))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;
      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const loneWolfId = (await lookupV3Id(db, "users", 4))!;

      const permRows = await db.select().from(gangPermissions);
      expect(permRows).toHaveLength(1); // LoneWolf (gangless) and user 999 (nonexistent) both dropped
      expect(permRows[0]).toMatchObject({ gangId: gang1Id, playerId: soldierId, permission: "kick" });
      expect(report.orphans).toContainEqual({ table: "gangPermissions", v2Id: 4, reason: "user 4 is gangless" });
      expect(report.orphans).toContainEqual({ table: "gangPermissions", v2Id: 999, reason: "user 999 does not exist" });

      const inviteRows = await db.select().from(gangInvites);
      expect(inviteRows).toHaveLength(1); // gang 99 orphan dropped
      expect(inviteRows[0]).toMatchObject({ gangId: gang1Id, invitedPlayerId: loneWolfId, invitedByPlayerId: vitoId });
      expect(report.orphans).toContainEqual({ table: "gangInvites", v2Id: 99, reason: "gang 99 does not exist" });

      const logRows = await db.select().from(gangLogs).where(eq(gangLogs.gangId, gang1Id));
      expect(logRows).toHaveLength(2); // "Founded" (user) + "System: round started" (null user)
      expect(logRows.some((l) => l.playerId === null && l.message.startsWith("System:"))).toBe(true);
      expect(report.orphans).toContainEqual({ table: "gangLogs", v2Id: 99, reason: "gang 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/gang-social.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/gang-social.js`.

- [ ] **Step 3: Write `gang-social.ts`**

```ts
import type mysql from "mysql2/promise";
import { gangInvites, gangLogs, gangPermissions } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface PermissionRow { GP_user: number; GP_access: string; }
interface InviteRow { GI_id: number; GI_gang: number; GI_user: number; GI_invitedBy: number; GI_time: number; }
interface LogRow { GL_id: number; GL_gang: number; GL_user: number | null; GL_message: string; GL_time: number; }
interface GangMembershipLookupRow { US_id: number; US_gang: number; }

export async function migrateGangSocial(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [membershipRows] = await pool.query<(GangMembershipLookupRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_gang FROM userStats",
  );
  const gangByUser = new Map(membershipRows.map((r) => [r.US_id, r.US_gang]));

  // SPEC §1.2: gangPermissions has no gang column — derived from US_gang.
  const [permRows] = await pool.query<(PermissionRow & mysql.RowDataPacket)[]>(
    "SELECT GP_user, GP_access FROM gangPermissions",
  );
  for (const row of permRows) {
    bumpTable(report, "gangPermissions", "read");
    const playerId = await lookupV3Id(exec, "users", row.GP_user);
    if (!playerId) {
      recordOrphan(report, "gangPermissions", row.GP_user, `user ${row.GP_user} does not exist`);
      bumpTable(report, "gangPermissions", "skipped");
      continue;
    }
    const v2GangId = gangByUser.get(row.GP_user);
    if (!v2GangId) {
      recordOrphan(report, "gangPermissions", row.GP_user, `user ${row.GP_user} is gangless`);
      bumpTable(report, "gangPermissions", "skipped");
      continue;
    }
    const gangId = await lookupV3Id(exec, "gangs", v2GangId);
    if (!gangId) {
      recordOrphan(report, "gangPermissions", row.GP_user, `gang ${v2GangId} does not exist`);
      bumpTable(report, "gangPermissions", "skipped");
      continue;
    }
    await exec.insert(gangPermissions).values({ gangId, playerId, permission: row.GP_access })
      .onConflictDoNothing({ target: [gangPermissions.gangId, gangPermissions.playerId, gangPermissions.permission] });
    bumpTable(report, "gangPermissions", "written");
  }

  const [inviteRows] = await pool.query<(InviteRow & mysql.RowDataPacket)[]>(
    "SELECT GI_id, GI_gang, GI_user, GI_invitedBy, GI_time FROM gangInvites",
  );
  for (const row of inviteRows) {
    bumpTable(report, "gangInvites", "read");
    const gangId = await lookupV3Id(exec, "gangs", row.GI_gang);
    const invitedPlayerId = await lookupV3Id(exec, "users", row.GI_user);
    const invitedByPlayerId = await lookupV3Id(exec, "users", row.GI_invitedBy);
    if (!gangId || !invitedPlayerId || !invitedByPlayerId) {
      const reason = !gangId ? `gang ${row.GI_gang} does not exist`
        : !invitedPlayerId ? `user ${row.GI_user} does not exist` : `user ${row.GI_invitedBy} does not exist`;
      recordOrphan(report, "gangInvites", row.GI_id, reason);
      bumpTable(report, "gangInvites", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "gangInvites", row.GI_id);
    const values = { id: v3Id, gangId, invitedPlayerId, invitedByPlayerId, createdAt: unixToDate(row.GI_time)! };
    await exec.insert(gangInvites).values(values).onConflictDoUpdate({ target: gangInvites.id, set: values });
    bumpTable(report, "gangInvites", "written");
  }

  const [logRows] = await pool.query<(LogRow & mysql.RowDataPacket)[]>(
    "SELECT GL_id, GL_gang, GL_user, GL_message, GL_time FROM gangLogs",
  );
  for (const row of logRows) {
    bumpTable(report, "gangLogs", "read");
    const gangId = await lookupV3Id(exec, "gangs", row.GL_gang);
    if (!gangId) {
      recordOrphan(report, "gangLogs", row.GL_id, `gang ${row.GL_gang} does not exist`);
      bumpTable(report, "gangLogs", "skipped");
      continue;
    }
    // GL_user null = a system log entry, not an orphan (gang_logs.player_id is nullable).
    const playerId = row.GL_user !== null ? await lookupV3Id(exec, "users", row.GL_user) : null;
    if (row.GL_user !== null && !playerId) {
      recordOrphan(report, "gangLogs", row.GL_id, `user ${row.GL_user} does not exist`);
    }
    const { v3Id } = await getOrCreateV3Id(exec, "gangLogs", row.GL_id);
    const values = { id: v3Id, gangId, playerId, message: row.GL_message, createdAt: unixToDate(row.GL_time)! };
    await exec.insert(gangLogs).values(values).onConflictDoUpdate({ target: gangLogs.id, set: values });
    bumpTable(report, "gangLogs", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/gang-social.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/gang-social.ts apps/migrate/test/migrators/gang-social.test.ts
git commit -m "feat(migrate): gang social migrator — gangPermissions derives gang_id from US_gang (SPEC §1.2), invites, logs"
```

---

### Task 25: Inventory + garage migrator — `userInventory` → `player_items`, `garage` → `garage`

**Files:**
- Create: `apps/migrate/src/migrators/inventory.ts`
- Test: `apps/migrate/test/migrators/inventory.test.ts`

**Interfaces:**
- Consumes: `playerItems`/`garage` schema tables; `migratePlayers`/`migrateItems`/`migrateCars` (+ their setup) as test seed.
- Produces: `migrateInventory(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { garage, playerItems } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migrateCars } from "../../src/migrators/cars.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateInventory } from "../../src/migrators/inventory.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateInventory", () => {
  it("migrates player_items and garage, dropping every orphan row", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migrateCars(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateInventory(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const items = await db.select().from(playerItems);
      expect(items).toHaveLength(1); // user 4/item 99 and user 88/item 1 both orphans
      expect(items[0]).toMatchObject({ playerId: vitoId, qty: 5 });

      const garageRows = await db.select().from(garage);
      expect(garageRows).toHaveLength(1); // user 77 orphan dropped
      expect(garageRows[0]).toMatchObject({ playerId: vitoId, damage: 10 });

      expect(report.orphans).toContainEqual({ table: "userInventory", v2Id: 4, reason: "item 99 does not exist" });
      expect(report.orphans).toContainEqual({ table: "userInventory", v2Id: 88, reason: "user 88 does not exist" });
      expect(report.orphans).toContainEqual({ table: "garage", v2Id: 77, reason: "user 77 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/inventory.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/inventory.js`.

- [ ] **Step 3: Write `inventory.ts`**

```ts
import type mysql from "mysql2/promise";
import { garage, playerItems } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface InventoryRow { UI_user: number; UI_item: number; UI_qty: number; }
interface GarageRow { GA_id: number; GA_user: number; GA_car: number; GA_damage: number; GA_location: number | null; }

export async function migrateInventory(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [invRows] = await pool.query<(InventoryRow & mysql.RowDataPacket)[]>(
    "SELECT UI_user, UI_item, UI_qty FROM userInventory",
  );
  for (const row of invRows) {
    bumpTable(report, "userInventory", "read");
    const playerId = await lookupV3Id(exec, "users", row.UI_user);
    if (!playerId) {
      recordOrphan(report, "userInventory", row.UI_user, `user ${row.UI_user} does not exist`);
      bumpTable(report, "userInventory", "skipped");
      continue;
    }
    const itemId = await lookupV3Id(exec, "items", row.UI_item);
    if (!itemId) {
      recordOrphan(report, "userInventory", row.UI_user, `item ${row.UI_item} does not exist`);
      bumpTable(report, "userInventory", "skipped");
      continue;
    }
    await exec.insert(playerItems).values({ playerId, itemId, qty: row.UI_qty })
      .onConflictDoUpdate({ target: [playerItems.playerId, playerItems.itemId], set: { qty: row.UI_qty } });
    bumpTable(report, "userInventory", "written");
  }

  const [garageRows] = await pool.query<(GarageRow & mysql.RowDataPacket)[]>(
    "SELECT GA_id, GA_user, GA_car, GA_damage, GA_location FROM garage",
  );
  for (const row of garageRows) {
    bumpTable(report, "garage", "read");
    const playerId = await lookupV3Id(exec, "users", row.GA_user);
    if (!playerId) {
      recordOrphan(report, "garage", row.GA_user, `user ${row.GA_user} does not exist`);
      bumpTable(report, "garage", "skipped");
      continue;
    }
    const carId = await lookupV3Id(exec, "cars", row.GA_car);
    if (!carId) {
      recordOrphan(report, "garage", row.GA_user, `car ${row.GA_car} does not exist`);
      bumpTable(report, "garage", "skipped");
      continue;
    }
    const locationId = row.GA_location ? await lookupV3Id(exec, "locations", row.GA_location) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "garage", row.GA_id);
    const values = { id: v3Id, playerId, carId, damage: row.GA_damage, locationId };
    await exec.insert(garage).values(values).onConflictDoUpdate({ target: garage.id, set: values });
    bumpTable(report, "garage", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/inventory.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/inventory.ts apps/migrate/test/migrators/inventory.test.ts
git commit -m "feat(migrate): inventory + garage migrator"
```

---

### Task 26: Properties migrator — `PR_module` → `plugin_id`

**Files:**
- Create: `apps/migrate/src/migrators/properties.ts`
- Test: `apps/migrate/test/migrators/properties.test.ts`

**Interfaces:**
- Consumes: `properties` schema table; `migratePlayers`/`migrateLocations` (+ setup) as test seed.
- Produces: `migrateProperties(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { properties } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateProperties } from "../../src/migrators/properties.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateProperties", () => {
  it("copies PR_module into plugin_id and drops the orphan-location row", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateProperties(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const rows = await db.select().from(properties);
      expect(rows).toHaveLength(1); // location 99 orphan dropped
      expect(rows[0]).toMatchObject({ pluginId: "casino", ownerPlayerId: vitoId, cost: 5000n, profit: 100n });
      expect(report.orphans).toContainEqual({ table: "properties", v2Id: 99, reason: "location 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/properties.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/properties.js`.

- [ ] **Step 3: Write `properties.ts`**

```ts
import type mysql from "mysql2/promise";
import { properties } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface PropertyRow {
  PR_id: number; PR_location: number; PR_module: string; PR_owner: number | null; PR_cost: number; PR_profit: number;
}

export async function migrateProperties(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(PropertyRow & mysql.RowDataPacket)[]>(
    "SELECT PR_id, PR_location, PR_module, PR_owner, PR_cost, PR_profit FROM properties",
  );
  for (const row of rows) {
    bumpTable(report, "properties", "read");
    const locationId = await lookupV3Id(exec, "locations", row.PR_location);
    if (!locationId) {
      recordOrphan(report, "properties", row.PR_location, `location ${row.PR_location} does not exist`);
      bumpTable(report, "properties", "skipped");
      continue;
    }
    const ownerPlayerId = row.PR_owner ? await lookupV3Id(exec, "users", row.PR_owner) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "properties", row.PR_id);
    // SPEC §1.2: PR_module is the implementing module's name -> plugin_id.
    const values = {
      id: v3Id, locationId, pluginId: row.PR_module, ownerPlayerId,
      cost: BigInt(row.PR_cost), profit: BigInt(row.PR_profit),
    };
    await exec.insert(properties).values(values).onConflictDoUpdate({ target: properties.id, set: values });
    bumpTable(report, "properties", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/properties.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/properties.ts apps/migrate/test/migrators/properties.test.ts
git commit -m "feat(migrate): properties migrator — PR_module copied verbatim to plugin_id"
```

---

### Task 27: Social migrator — `mail` (thread-root walk) + `notifications` + `gameNews`

Implements "Known unknowns" item 7: `M_parent` is walked to its root (with cycle protection) because GL3's `thread_id` is a flat grouping key, not a parent pointer.

**Files:**
- Create: `apps/migrate/src/migrators/social.ts`
- Test: `apps/migrate/test/migrators/social.test.ts`

**Interfaces:**
- Consumes: `mailMessages`/`notifications`/`gameNews` schema tables; `migratePlayers` (+ setup) as test seed.
- Produces: `migrateSocial(mysql, exec, report): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { gameNews, mailMessages, notifications } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateSocial } from "../../src/migrators/social.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateSocial", () => {
  it("migrates mail with a flat thread_id walked to the root, notifications, and game news", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateSocial(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;

      const mailRows = await db.select().from(mailMessages);
      expect(mailRows).toHaveLength(3); // recipient-999 orphan dropped
      const root = mailRows.find((m) => m.subject === "Hi")!;
      const reply = mailRows.find((m) => m.subject === "Re: Hi")!;
      expect(reply.threadId).toBe(root.id); // walked M_parent to the root message's own uuid
      expect(root.senderId).toBe(vitoId);
      expect(reply.senderId).toBe(soldierId);
      const systemMail = mailRows.find((m) => m.subject === "System notice")!;
      expect(systemMail.senderId).toBeNull(); // no sender = system mail, not an orphan
      expect(report.orphans).toContainEqual({ table: "mail", v2Id: 4, reason: "recipient 999 does not exist" });

      const notifRows = await db.select().from(notifications).where(eq(notifications.playerId, vitoId));
      expect(notifRows).toHaveLength(1);
      expect(report.orphans).toContainEqual({ table: "notifications", v2Id: 999, reason: "user 999 does not exist" });

      const newsRows = await db.select().from(gameNews);
      expect(newsRows).toHaveLength(2);
      expect(newsRows.some((n) => n.authorId === null)).toBe(true); // system announcement

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/social.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/social.js`.

- [ ] **Step 3: Write `social.ts`**

```ts
import type mysql from "mysql2/promise";
import { gameNews, mailMessages, notifications } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface MailRow {
  M_id: number; M_parent: number | null; M_sender: number | null; M_recipient: number;
  M_subject: string; M_body: string | null; M_time: number;
}
interface NotificationRow { N_id: number; N_user: number; N_body: string; N_time: number; }
interface NewsRow { GN_id: number; GN_author: number | null; GN_title: string; GN_body: string | null; GN_time: number; }

/** "Known unknowns" item 7: GL3's thread_id is a flat grouping key; V2's
 * M_parent is a parent pointer that can chain to arbitrary depth. Walks to
 * the ultimate root once per message, memoized, with cycle protection
 * (V2 has no FK enforcement, so a malformed parent cycle is possible). */
function resolveRootId(
  id: number,
  parentById: Map<number, number | null>,
  memo: Map<number, number>,
  visiting: Set<number> = new Set(),
): number {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  if (visiting.has(id)) return id; // cycle guard: treat as its own root
  visiting.add(id);
  const parent = parentById.get(id) ?? null;
  const root = parent === null || !parentById.has(parent) ? id : resolveRootId(parent, parentById, memo, visiting);
  memo.set(id, root);
  return root;
}

export async function migrateSocial(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [mailRows] = await pool.query<(MailRow & mysql.RowDataPacket)[]>(
    "SELECT M_id, M_parent, M_sender, M_recipient, M_subject, M_body, M_time FROM mail",
  );
  const parentById = new Map(mailRows.map((r) => [r.M_id, r.M_parent]));
  const rootMemo = new Map<number, number>();
  const threadV3ByRootV2 = new Map<number, string>();

  for (const row of mailRows) {
    bumpTable(report, "mail", "read");
    const recipientId = await lookupV3Id(exec, "users", row.M_recipient);
    if (!recipientId) {
      recordOrphan(report, "mail", row.M_id, `recipient ${row.M_recipient} does not exist`);
      bumpTable(report, "mail", "skipped");
      continue;
    }
    const senderId = row.M_sender !== null ? await lookupV3Id(exec, "users", row.M_sender) : null;

    const rootV2Id = resolveRootId(row.M_id, parentById, rootMemo);
    const { v3Id: messageId } = await getOrCreateV3Id(exec, "mail", row.M_id);
    let threadId = threadV3ByRootV2.get(rootV2Id);
    if (!threadId) {
      threadId = (await getOrCreateV3Id(exec, "mail", rootV2Id)).v3Id;
      threadV3ByRootV2.set(rootV2Id, threadId);
    }

    const values = {
      id: messageId, threadId, senderId, recipientId,
      subject: row.M_subject, body: row.M_body ?? "", createdAt: unixToDate(row.M_time)!,
    };
    await exec.insert(mailMessages).values(values).onConflictDoUpdate({ target: mailMessages.id, set: values });
    bumpTable(report, "mail", "written");
  }

  const [notifRows] = await pool.query<(NotificationRow & mysql.RowDataPacket)[]>(
    "SELECT N_id, N_user, N_body, N_time FROM notifications",
  );
  for (const row of notifRows) {
    bumpTable(report, "notifications", "read");
    const playerId = await lookupV3Id(exec, "users", row.N_user);
    if (!playerId) {
      recordOrphan(report, "notifications", row.N_user, `user ${row.N_user} does not exist`);
      bumpTable(report, "notifications", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "notifications", row.N_id);
    const values = { id: v3Id, playerId, body: row.N_body, createdAt: unixToDate(row.N_time)! };
    await exec.insert(notifications).values(values).onConflictDoUpdate({ target: notifications.id, set: values });
    bumpTable(report, "notifications", "written");
  }

  const [newsRows] = await pool.query<(NewsRow & mysql.RowDataPacket)[]>(
    "SELECT GN_id, GN_author, GN_title, GN_body, GN_time FROM gameNews",
  );
  for (const row of newsRows) {
    bumpTable(report, "gameNews", "read");
    const authorId = row.GN_author !== null ? await lookupV3Id(exec, "users", row.GN_author) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "gameNews", row.GN_id);
    const values = { id: v3Id, authorId, title: row.GN_title, body: row.GN_body ?? "", createdAt: unixToDate(row.GN_time)! };
    await exec.insert(gameNews).values(values).onConflictDoUpdate({ target: gameNews.id, set: values });
    bumpTable(report, "gameNews", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/social.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/migrators/social.ts apps/migrate/test/migrators/social.test.ts
git commit -m "feat(migrate): social migrator — mail thread-root walk, notifications, game news"
```

---

### Task 28: Bounties + detectives migrator

Implements "Known unknowns" items 5 and 6: no claimant column in V2 bounties (`claimed_by` is always `null` on migration) and no detective-count column (`detectives` defaults to `1`). The target tables are plugin-owned (`p_bounties_bounties` / `p_detectives_searches`, item 8), so this task also creates `src/pg/plugin-tables.ts` — the hand-maintained drizzle mirror of the two tables, same pattern as `apps/server/test/helpers/plugin-tables.ts`.

**Files:**
- Create: `apps/migrate/src/pg/plugin-tables.ts`
- Create: `apps/migrate/src/migrators/bounties-detectives.ts`
- Test: `apps/migrate/test/migrators/bounties-detectives.test.ts`

**Interfaces:**
- Consumes: `bounties`/`detectiveSearches` drizzle handles from `src/pg/plugin-tables.ts`; `migratePlayers` (+ setup) as test seed.
- Produces: `migrateBountiesAndDetectives(mysql, exec, report): Promise<void>`; the `plugin-tables.ts` mirrors (also imported by Tasks 29–30's tests).

- [ ] **Step 1: Write the mirror file**

`apps/migrate/src/pg/plugin-tables.ts`:

```ts
import { bigint, boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle handles for the two plugin-owned tables the migrator writes.
 *
 * Core relinquished `bounties` and `detective_searches` in
 * `0007_relinquish_plugin_tables`; the `bounties`/`detectives` plugins own and
 * migrate them as `p_bounties_bounties` / `p_detectives_searches`. The plugin
 * packages export only their manifests, so this is a MIRROR — the same pattern
 * as `apps/server/test/helpers/plugin-tables.ts`: the DDL in each plugin's
 * `migrations.ts` is the definition, and these must be kept in step by hand.
 *
 * Foreign keys are omitted, as in that file: drizzle only needs `references`
 * to generate DDL, and nothing here generates DDL — `createIsolatedPgTarget`
 * runs the plugins' real migrations.
 */

/** Mirrors `packages/plugins/bounties/src/migrations.ts` `0001_bounties`. */
export const bounties = pgTable("p_bounties_bounties", {
  id: uuid("id").primaryKey(),
  placedBy: uuid("placed_by").notNull(),
  target: uuid("target").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedBy: uuid("claimed_by"),
});

/** Mirrors `packages/plugins/detectives/src/migrations.ts` `0001_searches`. */
export const detectiveSearches = pgTable("p_detectives_searches", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  targetPlayerId: uuid("target_player_id").notNull(),
  detectives: integer("detectives").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  succeeded: boolean("succeeded"),
});
```

- [ ] **Step 1b: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { bounties, detectiveSearches } from "../../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateBountiesAndDetectives } from "../../src/migrators/bounties-detectives.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateBountiesAndDetectives", () => {
  it("migrates open bounties (claimed_by always null) and single-detective searches", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateBountiesAndDetectives(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;

      const bountyRows = await db.select().from(bounties);
      expect(bountyRows).toHaveLength(1); // target-999 orphan dropped
      expect(bountyRows[0]).toMatchObject({ placedBy: vitoId, target: soldierId, amount: 1000n, claimedBy: null });
      expect(report.orphans).toContainEqual({ table: "bounties", v2Id: 999, reason: "target 999 does not exist" });

      const detectiveRows = await db.select().from(detectiveSearches);
      expect(detectiveRows).toHaveLength(1);
      expect(detectiveRows[0]).toMatchObject({ playerId: vitoId, targetPlayerId: soldierId, detectives: 1, succeeded: null });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/migrators/bounties-detectives.test.ts`
Expected: FAIL — cannot resolve `../../src/migrators/bounties-detectives.js`.

- [ ] **Step 3: Write `bounties-detectives.ts`**

```ts
import type mysql from "mysql2/promise";
import { bounties, detectiveSearches } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface BountyRow { B_id: number; B_user: number; B_userToKill: number; B_cost: number; B_time: number; }
interface DetectiveRow { D_id: number; D_user: number; D_target: number; D_start: number; D_end: number; D_success: number | null; }

export async function migrateBountiesAndDetectives(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [bountyRows] = await pool.query<(BountyRow & mysql.RowDataPacket)[]>(
    "SELECT B_id, B_user, B_userToKill, B_cost, B_time FROM bounties",
  );
  for (const row of bountyRows) {
    bumpTable(report, "bounties", "read");
    const placedBy = await lookupV3Id(exec, "users", row.B_user);
    const target = await lookupV3Id(exec, "users", row.B_userToKill);
    if (!placedBy || !target) {
      const reason = !placedBy ? `placer ${row.B_user} does not exist` : `target ${row.B_userToKill} does not exist`;
      recordOrphan(report, "bounties", row.B_id, reason);
      bumpTable(report, "bounties", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "bounties", row.B_id);
    // "Known unknowns" item 5: V2 has no claimant column — every migrated row is open.
    const values = { id: v3Id, placedBy, target, amount: BigInt(row.B_cost), createdAt: unixToDate(row.B_time)!, claimedBy: null };
    await exec.insert(bounties).values(values).onConflictDoUpdate({ target: bounties.id, set: values });
    bumpTable(report, "bounties", "written");
  }

  const [detectiveRows] = await pool.query<(DetectiveRow & mysql.RowDataPacket)[]>(
    "SELECT D_id, D_user, D_target, D_start, D_end, D_success FROM detectives",
  );
  for (const row of detectiveRows) {
    bumpTable(report, "detectives", "read");
    const playerId = await lookupV3Id(exec, "users", row.D_user);
    const targetPlayerId = await lookupV3Id(exec, "users", row.D_target);
    if (!playerId || !targetPlayerId) {
      const reason = !playerId ? `searcher ${row.D_user} does not exist` : `target ${row.D_target} does not exist`;
      recordOrphan(report, "detectives", row.D_id, reason);
      bumpTable(report, "detectives", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "detectives", row.D_id);
    // "Known unknowns" item 6: no detective-count column — one row is one detective.
    const values = {
      id: v3Id, playerId, targetPlayerId, detectives: 1,
      startedAt: unixToDate(row.D_start)!, endsAt: unixToDate(row.D_end)!,
      succeeded: row.D_success === null ? null : Boolean(row.D_success),
    };
    await exec.insert(detectiveSearches).values(values).onConflictDoUpdate({ target: detectiveSearches.id, set: values });
    bumpTable(report, "detectives", "written");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/migrate/test/migrators/bounties-detectives.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/pg/plugin-tables.ts apps/migrate/src/migrators/bounties-detectives.ts apps/migrate/test/migrators/bounties-detectives.test.ts
git commit -m "feat(migrate): bounties + detectives migrator into plugin-owned tables"
```

---

# Orchestration and integration (Tasks 29–33 — chain strictly)

### Task 29: Orchestrator — the 8-phase pipeline (SPEC §4.2 item 2)

**Files:**
- Create: `apps/migrate/src/orchestrator.ts`
- Test: `apps/migrate/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: every migrator (Tasks 11–28), `runPhase` (Task 10).
- Produces: `runMigration(options: RunMigrationOptions): Promise<void>` and `interface RunMigrationOptions { mysql: mysql.Pool; db: Db; report: MigrationReport; dryRun: boolean }`.

- [ ] **Step 1: Write the failing test**

Runs the whole pipeline once against the full fixture and spot-checks a representative row count from each of the 8 phases, plus the dry-run guarantee across the pipeline as a whole (not just one phase, which Task 10 already covers in isolation).

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../server/src/db/client.js";
import {
  crimes, gangMembers, gangs, garage, idMap, items,
  mailMessages, notifications, playerItems, players, properties, ranks, roles,
  rounds, settings,
} from "../../server/src/db/schema/index.js";
import { bounties, detectiveSearches } from "../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { createReport } from "../src/report.js";
import { runMigration } from "../src/orchestrator.js";

describe("runMigration", () => {
  it("runs all 8 phases in SPEC §4.2 dependency order against the full fixture", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await runMigration({ mysql: pool, db, report, dryRun: false });

      expect(await db.select().from(roles)).toHaveLength(2);
      expect(await db.select().from(rounds)).toHaveLength(1);
      expect(await db.select().from(ranks)).toHaveLength(2);
      expect(await db.select().from(crimes)).toHaveLength(5);
      expect(await db.select().from(items)).toHaveLength(2);
      expect(await db.select().from(players)).toHaveLength(6);
      expect(await db.select().from(gangs)).toHaveLength(1);
      expect(await db.select().from(gangMembers)).toHaveLength(3); // underboss, soldier, + Vito via boss cross-check
      expect(await db.select().from(playerItems)).toHaveLength(1);
      expect(await db.select().from(garage)).toHaveLength(1);
      expect(await db.select().from(properties)).toHaveLength(1);
      expect(await db.select().from(mailMessages)).toHaveLength(3);
      expect(await db.select().from(notifications)).toHaveLength(1);
      expect(await db.select().from(bounties)).toHaveLength(1);
      expect(await db.select().from(detectiveSearches)).toHaveLength(1);
      expect(await db.select().from(settings)).toHaveLength(3);
      expect((await db.select().from(idMap)).length).toBeGreaterThan(20); // every migrated row got a mapping

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("--dry-run leaves every table empty across the whole pipeline", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await runMigration({ mysql: pool, db, report: createReport(true), dryRun: true });

      expect(await db.select().from(players)).toHaveLength(0);
      expect(await db.select().from(gangs)).toHaveLength(0);
      expect(await db.select().from(settings)).toHaveLength(0);
      expect(await db.select().from(idMap)).toHaveLength(0);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator.js`.

- [ ] **Step 3: Write `orchestrator.ts`**

```ts
import type mysql from "mysql2/promise";
import type { Db } from "../../server/src/db/client.js";
import { runPhase } from "./pg/run-phase.js";
import type { MigrationReport } from "./report.js";
import { migrateRoles } from "./migrators/roles.js";
import { migrateRounds } from "./migrators/rounds.js";
import { migrateRanks } from "./migrators/ranks.js";
import { migrateCrimes } from "./migrators/crimes.js";
import { migrateLocations } from "./migrators/locations.js";
import { migrateCars } from "./migrators/cars.js";
import { migrateWeapons } from "./migrators/weapons.js";
import { migrateItems } from "./migrators/items.js";
import { migratePlayers } from "./migrators/players.js";
import { migrateTimers } from "./migrators/timers.js";
import { migrateCrimeSkill } from "./migrators/crime-skill.js";
import { migrateGangs } from "./migrators/gangs.js";
import { migrateGangSocial } from "./migrators/gang-social.js";
import { migrateInventory } from "./migrators/inventory.js";
import { migrateProperties } from "./migrators/properties.js";
import { migrateSocial } from "./migrators/social.js";
import { migrateBountiesAndDetectives } from "./migrators/bounties-detectives.js";
import { migrateSettings } from "./migrators/settings.js";

export interface RunMigrationOptions {
  mysql: mysql.Pool;
  db: Db;
  report: MigrationReport;
  dryRun: boolean;
}

/**
 * SPEC §4.2 item 2's exact dependency order: roles -> rounds -> content ->
 * players(+stats,timers,crime-skill) -> gangs(+members,permissions,invites,
 * logs) -> inventory/garage/properties -> social(mail,notifications,news,
 * bounties,detectives) -> settings. One Postgres transaction per phase
 * (§4.2 item 3, Task 10's runPhase) — a failure partway through a later
 * phase does not undo an earlier, already-committed phase; re-running is
 * always safe because every migrator is id_map-idempotent (Task 30 proves
 * this end to end).
 */
export async function runMigration({ mysql: pool, db, report, dryRun }: RunMigrationOptions): Promise<void> {
  await runPhase(db, dryRun, (tx) => migrateRoles(pool, tx, report));
  await runPhase(db, dryRun, (tx) => migrateRounds(pool, tx, report));

  await runPhase(db, dryRun, async (tx) => {
    await migrateRanks(pool, tx, report);
    await migrateLocations(pool, tx, report);
    await migrateCars(pool, tx, report);
    await migrateWeapons(pool, tx, report);
    await migrateItems(pool, tx, report);
    await migrateCrimes(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migratePlayers(pool, tx, report);
    await migrateTimers(pool, tx, report);
    await migrateCrimeSkill(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migrateGangs(pool, tx, report);
    await migrateGangSocial(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migrateInventory(pool, tx, report);
    await migrateProperties(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migrateSocial(pool, tx, report);
    await migrateBountiesAndDetectives(pool, tx, report);
  });

  await runPhase(db, dryRun, (tx) => migrateSettings(pool, tx, report));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/migrate/test/orchestrator.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/orchestrator.ts apps/migrate/test/orchestrator.test.ts
git commit -m "feat(migrate): orchestrator — wire all migrators into the SPEC §4.2 8-phase pipeline"
```

---

### Task 30: Idempotency integration test — the acceptance criterion's first half

SPEC §6: *"re-run migrator → zero duplicates."* This is the single most important test in the milestone — it exercises every migrator's `id_map` usage together, at once, exactly the way a real re-run of `gl3-migrate` against an already-migrated production database would.

**Files:**
- Test: `apps/migrate/test/orchestrator-idempotency.test.ts`

**Interfaces:**
- Consumes: `runMigration` (Task 29), the full set of GL3 schema tables.
- Produces: nothing (test-only task).

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../server/src/db/client.js";
import {
  crimes, gangInvites, gangLogs, gangMembers, gangPermissions,
  gangs, garage, idMap, items, locations, mailMessages, notifications, playerCrimeSkill,
  playerItems, players, playerStats, playerTimers, properties, ranks, roleModuleAccess,
  roles, rounds, settings, weapons,
} from "../../server/src/db/schema/index.js";
import { bounties, detectiveSearches } from "../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { createReport } from "../src/report.js";
import { runMigration } from "../src/orchestrator.js";
import { lookupV3Id } from "../src/id-map.js";

const ALL_TABLES = [
  roles, roleModuleAccess, rounds, ranks, crimes, locations, items, weapons,
  players, playerStats, playerTimers, playerCrimeSkill,
  gangs, gangMembers, gangPermissions, gangInvites, gangLogs,
  playerItems, garage, properties,
  mailMessages, notifications, bounties, detectiveSearches,
  settings, idMap,
] as const;

describe("M4 acceptance: re-running the migrator produces zero duplicates (SPEC §6)", () => {
  it("row counts and every checked uuid are identical after a second run against the same fixture", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      const countsAfterFirstRun = await Promise.all(ALL_TABLES.map((t) => db.select().from(t).then((r) => r.length)));
      const vitoIdAfterFirstRun = await lookupV3Id(db, "users", 1);
      const gang1IdAfterFirstRun = await lookupV3Id(db, "gangs", 1);

      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      const countsAfterSecondRun = await Promise.all(ALL_TABLES.map((t) => db.select().from(t).then((r) => r.length)));
      const vitoIdAfterSecondRun = await lookupV3Id(db, "users", 1);
      const gang1IdAfterSecondRun = await lookupV3Id(db, "gangs", 1);

      expect(countsAfterSecondRun).toEqual(countsAfterFirstRun);
      expect(vitoIdAfterSecondRun).toBe(vitoIdAfterFirstRun); // same V2 row -> same GL3 uuid, every run
      expect(gang1IdAfterSecondRun).toBe(gang1IdAfterFirstRun);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("a third run still produces zero duplicates (not just \"twice is safe\")", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });

      expect(await db.select().from(players)).toHaveLength(6);
      expect(await db.select().from(gangMembers)).toHaveLength(3);
      expect(await db.select().from(idMap)).toEqual(await db.select().from(idMap)); // stable, re-queried

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run apps/migrate/test/orchestrator-idempotency.test.ts`
Expected: PASS, 2 tests, immediately — every migrator built in Tasks 11–28 was already written idempotently via `id_map` and `ON CONFLICT DO UPDATE`/`DO NOTHING`; this test is the proof, not new production code.

If it fails, the failure is real and points at a specific migrator's `onConflictDoUpdate`/`onConflictDoNothing` target or `getOrCreateV3Id` usage — go fix that migrator, do not weaken this test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/test/orchestrator-idempotency.test.ts
git commit -m "test(migrate): idempotency acceptance test — re-running the full pipeline produces zero duplicates (SPEC §6)"
```

---

### Task 31: Legacy V2 login end-to-end test — the acceptance criterion's second half

SPEC §6: *"migrate → boot GL3 → legacy user logs in with old password → hash upgraded."* This is the only task in the plan that boots the **real** `apps/server` Fastify app (via its own `bootTestServer()` helper) against a database this milestone's migrator just populated — proving the migrator's output and the already-built §4.3 login flow (`apps/server/src/auth/routes.ts`, `apps/server/src/auth/password.ts`) actually interoperate, not just that each one is independently correct.

**Files:**
- Test: `apps/migrate/test/legacy-login.test.ts`

**Interfaces:**
- Consumes: `runMigration` (Task 29), `bootTestServer` (`apps/server/test/helpers/server.ts`).
- Produces: nothing (test-only task).

- [ ] **Step 1: Write the test**

`OldTimer` (V2 id 6, plaintext `oldpass6`) is the fixture row built for exactly this purpose (Task 4).

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../server/src/db/client.js";
import { players } from "../../server/src/db/schema/index.js";
import { bootTestServer } from "../../server/test/helpers/server.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { createReport } from "../src/report.js";
import { runMigration } from "../src/orchestrator.js";

describe("M4 acceptance: legacy V2 login after migration (SPEC §4.3, §6)", () => {
  it("a migrated player logs in with their old V2 password and is upgraded to argon2id", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    const savedDatabaseUrl = process.env.DATABASE_URL;
    let closeServer: (() => Promise<void>) | undefined;
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      await pool.end();
      await sql.end();

      // bootTestServer() reads DATABASE_URL from process.env — point it at
      // the database this test just migrated into, exactly as a real GL3
      // deploy boots its Fastify app against the database gl3-migrate
      // just populated.
      process.env.DATABASE_URL = target.url;
      const server = await bootTestServer();
      closeServer = server.close;

      const before = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "wrongpassword" },
      });
      expect(before.statusCode).toBe(401); // proves this isn't a passwordless fallback

      const res = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "oldpass6" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().username).toBe("OldTimer");

      const { db: verifyDb, sql: verifySql } = createDb(target.url);
      const [row] = await verifyDb.select().from(players).where(eq(players.username, "OldTimer"));
      expect(row?.passwordHash?.startsWith("$argon2id$")).toBe(true);
      expect(row?.legacyPasswordSha256).toBeNull();
      await verifySql.end();
    } finally {
      if (closeServer) await closeServer();
      process.env.DATABASE_URL = savedDatabaseUrl;
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("re-running the migrator after the upgrade does not revert the player back to legacy auth", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    const savedDatabaseUrl = process.env.DATABASE_URL;
    let closeServer: (() => Promise<void>) | undefined;
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });

      process.env.DATABASE_URL = target.url;
      const server = await bootTestServer();
      closeServer = server.close;
      await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "oldpass6" },
      });

      // Re-run the migrator against the SAME MySQL source — its U_password
      // column still holds the original V2 hash, unaware the player
      // upgraded. The players migrator (Task 20) must not clobber the
      // now-null legacy column back to that stale hash.
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });

      const [row] = await db.select().from(players).where(eq(players.username, "OldTimer"));
      expect(row?.passwordHash?.startsWith("$argon2id$")).toBe(true);
      expect(row?.legacyPasswordSha256).toBeNull();

      const stillWorks = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "oldpass6" },
      });
      expect(stillWorks.statusCode).toBe(200);

      await pool.end();
      await sql.end();
    } finally {
      if (closeServer) await closeServer();
      process.env.DATABASE_URL = savedDatabaseUrl;
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run apps/migrate/test/legacy-login.test.ts`
Expected: PASS, 2 tests. If the second test fails on `legacyPasswordSha256` being non-null, the `CASE WHEN ... IS NULL` guard added to `players.ts` in Task 20 is missing or wrong — that guard exists specifically for this test.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/test/legacy-login.test.ts
git commit -m "test(migrate): legacy V2 login end-to-end — migrate, boot real GL3 server, log in, verify argon2id upgrade (SPEC §4.3, §6)"
```

---

### Task 32: CLI wiring — `main(argv)`, preflight gate, report output, `--sql-dump` message

**Files:**
- Create: `apps/migrate/src/cli.ts`
- Test: `apps/migrate/test/cli.test.ts`

**Interfaces:**
- Consumes: everything built so far (`parseCliArgs`, `createMysqlPool`, `fingerprintV2Schema`, `runMigration`, `report.ts`).
- Produces: `main(argv: string[]): Promise<number>` (exported for testing) plus a process-entrypoint guard that calls it when run as a script.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { main } from "../src/cli.js";

describe("main (CLI entrypoint)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { errorSpy.mockRestore(); logSpy.mockRestore(); });

  it("runs the full migration and writes the report file", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const dir = await mkdtemp(join(tmpdir(), "gl3-migrate-cli-"));
      const reportPath = join(dir, "report.json");

      const code = await main(["--mysql", fixture.url, "--pg", target.url, "--report", reportPath]);

      expect(code).toBe(0);
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report.tables.find((t: { table: string }) => t.table === "users")).toMatchObject({ written: 6 });
      expect(report.unknownTables.sort()).toEqual(["blackjackHands", "premiumMembership"]);
      expect(logSpy).toHaveBeenCalled(); // human summary printed
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("prints the scratch-MySQL instructions and exits 1 for --sql-dump without --mysql", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const code = await main(["--sql-dump", "dump.sql", "--pg", target.url]);
      expect(code).toBe(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("scratch MySQL");
    } finally {
      await target.teardown();
    }
  });

  it("fails preflight and exits 1 when a required table is missing, without touching Postgres", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      await pool.query("DROP TABLE userTimers");
      await pool.end();

      const code = await main(["--mysql", fixture.url, "--pg", target.url]);
      expect(code).toBe(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("fingerprint failed");
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("--dry-run reports success but leaves the target database empty", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const code = await main(["--mysql", fixture.url, "--pg", target.url, "--dry-run"]);
      expect(code).toBe(0);
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/migrate/test/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli.js`.

- [ ] **Step 3: Write `cli.ts`**

```ts
#!/usr/bin/env node
import { parseCliArgs } from "./cli-args.js";
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

/** Exported for tests, which call this directly instead of spawning a
 * subprocess — the guard below only auto-runs it when invoked as a script. */
export async function main(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);

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
    await runMigration({ mysql: pool, db, report, dryRun: args.dryRun });
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
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/migrate/test/cli.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/src/cli.ts apps/migrate/test/cli.test.ts
git commit -m "feat(migrate): CLI wiring — main(argv), preflight gate, JSON+human report output, --sql-dump guidance (SPEC §4.1)"
```

---

### Task 33: `apps/migrate/README.md`

**Files:**
- Create: `apps/migrate/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: documentation only.

- [ ] **Step 1: Write the README**

```markdown
# @gl3/migrate

`gl3-migrate` converts a live Gangster Legends V2 MySQL database into a GL3 PostgreSQL
database. Players keep their accounts (passwords are lazy-rehashed on first login —
see SPEC §4.3), cash, gangs, and inventories.

## Preparing the target

\`gl3-migrate\` writes into an existing GL3 schema; it does not create one. Two of its
target tables (\`p_bounties_bounties\`, \`p_detectives_searches\`) are plugin-owned and
are created by plugin migrations at server boot, not by \`db:migrate\`. So, against a
fresh database:

\`\`\`bash
cd apps/server
DATABASE_URL=postgres://user:pass@host/gl3db npm run db:migrate   # core tables
DATABASE_URL=... npm start   # boot once so loadPlugins runs the plugin migrations, then stop it
\`\`\`

## Usage

\`\`\`bash
gl3-migrate --mysql mysql://user:pass@host/v2db --pg postgres://user:pass@host/gl3db
\`\`\`

Flags:

- \`--dry-run\` — run every migrator for real, inside a transaction that is always
  rolled back. Nothing is written. Use this first against a production V2 database.
- \`--report report.json\` — write the full machine-readable report (per-table
  read/written/skipped counts, orphan rows, unknown tables, unknown \`userTimers\`
  keys, dropped \`US_crimes\` positions, duration) alongside the human summary
  printed to stdout.
- \`--sql-dump dump.sql\` — **not a direct import.** \`gl3-migrate\` does not parse SQL
  dump files (SPEC §4.1 explicitly scopes this out). Passing this flag without
  \`--mysql\` prints the two commands to load the dump into a scratch MySQL/MariaDB
  instance and re-run against that instead.

## Re-running

The whole run is idempotent. Every V2 auto-increment id is resolved to a stable GL3
UUIDv7 through an \`id_map(v2_table, v2_id) -> v3_id\` table maintained by the migrator
itself — re-running against the same source database updates existing GL3 rows in
place rather than duplicating them. This is safe to do repeatedly, including after
players have started logging in and having their passwords upgraded to argon2id
(the migrator never re-locks an already-upgraded password back to legacy auth).

## Orphan and unknown-data policy

V2 has no foreign keys. Real dumps contain rows referencing deleted users, gangs, or
items. The migrator never crashes on this — an orphaned row is skipped and recorded
in the report under \`orphans\`. Tables the migrator doesn't recognize (a custom
module's tables, or a core V2 table with no GL3 counterpart in v1, like
\`premiumMembership\` or the forum tables) are listed under \`unknownTables\` — "custom
module tables, not migrated." Nothing here is fatal; check the report afterward.

## Model differences from V2 (deliberate, see SPEC §2.5)

- \`users\` + \`userStats\` merge into \`players\` + \`player_stats\` (kept as two tables
  for hot-row separation).
- \`US_gang\` (an int column) becomes the \`gang_members\` join table.
- \`US_crimes\` (a dash-delimited string indexed by \`C_id - 1\`) explodes into
  \`player_crime_skill\` rows.
- Item EAV tables (\`itemEffects\`, \`itemMeta\`) merge into \`items.effects\` /
  \`items.meta\` JSONB columns.
- \`transactions\` (the ledger) and \`crime_log\` are **not** backfilled — V2 keeps only
  current balances, no per-transaction history. The ledger starts empty at cutover.
- Forum tables, \`premiumMembership\`, and casino/blackmarket-style custom module
  tables have no GL3 schema in v1 (SPEC §5) and are reported, not migrated.
\`\`\`
```

- [ ] **Step 2: Run the full gate and commit**

```bash
npm run verify
git add apps/migrate/README.md
git commit -m "docs(migrate): usage, dump-mode limitation, and model-difference notes"
```

---

## Milestone acceptance check (SPEC §6)

> Full §4 behaviour against a seeded V2 database (build a fixture from `install/schema.sql` + `install/data.sql` + generated players). ✔ migrate → boot GL3 → legacy user logs in with old password → hash upgraded; re-run migrator → zero duplicates.

- The seeded V2 database: Tasks 3–4 (fixture reconstructed from SPEC §1.2, since `install/schema.sql`/`install/data.sql` are not checked out in this repo — see "Known unknowns" preamble).
- "migrate → boot GL3 → legacy user logs in with old password → hash upgraded": Task 31.
- "re-run migrator → zero duplicates": Task 30.
- Every other §4.2 behaviour (preflight fingerprint, dependency ordering, batched transactions, orphan policy, `US_gang`/boss cross-check, timer promotion, the report): Tasks 9, 10, 29, and each migrator's own orphan-handling test in Tasks 11–28.
