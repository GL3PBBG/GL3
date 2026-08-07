# GL3 M4 — Migration CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/migrate`, a CLI that converts a live V2 MySQL database into a working GL3 Postgres game — players keep accounts (lazy-rehashed passwords), cash, gangs, and inventories — and prove it against a seeded V2 fixture built for this milestone (no `install/schema.sql` checkout exists in this repo).

**Architecture:** A single-binary Node CLI (`gl3-migrate`) that reads argv, connects to both databases, runs a **schema-fingerprint preflight**, then a strictly-ordered 8-phase pipeline (roles → rounds → content → players → gangs → inventory/garage/properties → social → settings). Each phase runs inside its own Postgres transaction (§4.2 "batched transactions"); `--dry-run` runs every phase's transaction for real and then rolls it back, so every code path is exercised but nothing durable is written. Every V2 auto-increment id is resolved to a stable GL3 UUIDv7 through `id_map(v2_table, v2_id) → v3_id`, looked up before insert and reused on re-run — this single mechanism is what makes the whole run idempotent, not per-migrator special-casing. Orphans (rows referencing a missing user/gang/item) are skipped and counted, never fatal. A `MigrationReport` accumulates per-table counts, orphan lists, unknown tables/timer keys, and dropped `US_crimes` positions, and is written as JSON (`--report`) and printed as a human summary.

**Tech Stack:** Node 22 LTS (ESM) · TypeScript strict · `mysql2/promise` · Drizzle ORM + `postgres` driver (reusing `apps/server`'s schema — GL3 has one schema, not two) · MariaDB 10.11 (native, V2-compatible substitute for MySQL — see Task 1) · PostgreSQL 16 · zod · vitest.

## Independence groups (for parallel worktrees)

- **Task 1** (install/start MariaDB, create the fixture DB) has no code dependency on anything else — do it first, in parallel with Task 2 if two workers are available.
- **Tasks 1 → 2** is the only hard prerequisite before any other task starts (Task 2 creates the `apps/migrate` package every later task's files live under).
- After Task 2: **Tasks 3, 5, 6, 8 are mutually independent** (disjoint files: fixture SQL, Postgres test isolation, MySQL client, report module) — parallelize freely.
- **Task 4** needs Task 1 (MariaDB running) + Task 3 (schema file to load). **Task 7** needs Task 5 (a Postgres db to test id_map against). **Task 9** needs Task 4 (a loaded fixture) + Task 6 (a client to query it with). **Task 10** needs Task 5. Tasks 1–10 together are "the foundation."
- **Tasks 11–28 are the per-table/per-domain migrators — fully independent of each other**, disjoint files under `src/migrators/`, each depending only on the foundation (Tasks 1–10) being merged. This is the big parallelization opportunity: 18 tasks, 18 separate worktrees if you have them. Grouped by GL3 phase for reference: roles(11) · rounds(12) · content(13–18) · players core(20) · timers(21) · crime-skill(22) · gangs(23–24) · inventory/garage/properties(25–26) · social(27–28). (Task 19, settings, is also in this independent band — numbered late only because it is small.)
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
- **`transactions` and `crime_log` are NOT backfilled from V2.** V2 keeps only current balances, no per-transaction history — there is nothing to migrate into an append-only ledger. The ledger starts empty at cutover. This is a deliberate scope limit, stated once here, not a bug to "fix" in a later task.
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
- `src/migrators/bounties-detectives.ts` — `bounties` + `detectives` → `bounties` + `detective_searches`
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

`apps/migrate/tsconfig.json` — references `../server` because every migrator imports the GL3 schema and `createDb` straight from `apps/server/src`, not a duplicate copy (SPEC §2.5 defines one schema, used by both apps):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../server" }]
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
