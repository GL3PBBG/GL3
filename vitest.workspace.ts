import { fileURLToPath } from "node:url";
import { defineWorkspace } from "vitest/config";

// Resolve @gl3/shared to its TypeScript source, not packages/shared/dist —
// dist is a build artifact that can go stale relative to src (it only
// rebuilds via `tsc --build`, which `npx vitest` never triggers), so
// resolving to dist here would let a stale build pass tests with a false
// green. Runtime (apps/server/src/index.ts, the built server) is
// unaffected: this alias only applies inside these vitest projects.
const sharedAlias = {
  resolve: {
    alias: {
      "@gl3/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
};

// Runs once for the whole run, before any test file starts: builds (or
// reuses) the migrated template database that isolated-db.setup.ts clones
// from. Doing the actual migration once here — instead of once per file —
// is what keeps per-file setup cost flat as the suite grows across M2–M5
// (see global-setup.ts). Only projects below whose files actually touch
// Postgres declare it; a project that never opens a DB connection has
// nothing for it to build.
const globalSetup = ["./test/helpers/global-setup.ts"];
const isolatedDb = "./test/helpers/isolated-db.setup.ts";
const rateLimitIsolation = "./test/helpers/rate-limit-isolation.setup.ts";

// vitest.config.ts's root `test.hookTimeout` does NOT flow into
// defineWorkspace projects (verified empirically: setting it there alone
// still produced "Hook timed out in 10000ms" failures) — each project's
// own `test` block must set it directly. 30s, not the default 10s, because
// isolated-db.setup.ts's afterAll (pg_terminate_backend + DROP DATABASE
// against a real Postgres instance) is real, unavoidable work for any file
// that actually needs its own database, and this host's load is not
// steady: an observed run went from a normal ~53s full-suite wall time to
// ~115-122s (file-level durations more than doubling) under a burst of
// other concurrent activity on the same box, which is exactly the
// "host-wide slowdown" scenario this exists to survive. Only applied to
// the two projects whose setupFiles actually include isolatedDb — the
// unit and redis-only projects have no such hook to wait on.
const dbHookTimeout = 30000;

/**
 * The single `@gl3/server` project used to run every server test file
 * through both setupFiles unconditionally: a private Postgres database
 * clone (CREATE DATABASE ... TEMPLATE, then DROP DATABASE in afterAll) and
 * a Redis rate-limit-bucket sweep, every file, every run — including files
 * like password.test.ts that call neither `testDb()`, `bootTestServer()`,
 * nor `createRedis()`. That paid-for-but-unused per-file DB clone/drop is
 * exactly the kind of avoidable work that turns into a flaky afterAll
 * `hookTimeout` under host-wide memory pressure, on a pure-unit test that
 * has no legitimate reason to be waiting on Postgres at all.
 *
 * Splitting into four projects — grouped by what each file's *code* under
 * test actually touches, not by convenience — lets each file's setupFiles
 * match its real dependencies:
 *   - unit:        neither Postgres nor Redis (config, password, rng)
 *   - redis-only:  Redis but no Postgres (cooldown, rate-limit)
 *   - db-only:     Postgres but no Redis (ledger, schema)
 *   - (default):   both, via `bootTestServer()` and/or direct
 *                   `testDb()`/`createRedis()` calls — the majority
 *
 * All four still run in parallel across the same worker pool (nothing here
 * disables `maxWorkers`/file parallelism); this only removes setup/teardown
 * work a file was never going to use.
 *
 * When adding a new test file: put it in the project matching what it
 * actually calls (`testDb`/`bootTestServer` → needs Postgres;
 * `createRedis`/`bootTestServer` → needs Redis). Defaulting a new file into
 * the "both" project is always *safe*, just not free.
 */
export default defineWorkspace([
  "packages/*",
  {
    test: {
      name: "@gl3/server:unit",
      root: "./apps/server",
      include: ["test/config.test.ts", "test/password.test.ts", "test/rng.test.ts"],
    },
    ...sharedAlias,
  },
  {
    test: {
      name: "@gl3/server:redis-only",
      root: "./apps/server",
      include: ["test/cooldown.test.ts", "test/rate-limit.test.ts"],
      // No rateLimitIsolation setupFile: neither file boots a server or
      // exercises the real ratelimit:register:*/ratelimit:login:* keys —
      // rate-limit.test.ts drives tokenBucket() directly against its own
      // randomly-named buckets, so the shared-Redis collision this setupFile
      // guards against doesn't apply here.
    },
    ...sharedAlias,
  },
  {
    test: {
      name: "@gl3/server:db-only",
      root: "./apps/server",
      include: ["test/ledger.test.ts", "test/schema.test.ts", "test/gang-ledger.test.ts"],
      globalSetup,
      setupFiles: [isolatedDb],
      hookTimeout: dbHookTimeout,
    },
    ...sharedAlias,
  },
  {
    test: {
      name: "@gl3/server",
      root: "./apps/server",
      include: [
        "test/auth.test.ts",
        "test/bank.test.ts",
        "test/bullets.test.ts",
        "test/crime-worker-idempotency.test.ts",
        "test/crimes.test.ts",
        "test/economy-invariant.test.ts",
        "test/gang-invites.test.ts",
        "test/gang-membership.test.ts",
        "test/gangs.test.ts",
        "test/health.test.ts",
        "test/jail.test.ts",
        "test/leaderboard.test.ts",
        "test/notifications.test.ts",
        "test/ranks.test.ts",
        "test/travel.test.ts",
        "test/ws.test.ts",
        "test/acceptance/**/*.test.ts",
      ],
      globalSetup,
      setupFiles: [isolatedDb, rateLimitIsolation],
      hookTimeout: dbHookTimeout,
    },
    ...sharedAlias,
  },
]);
