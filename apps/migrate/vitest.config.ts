import { defineConfig } from "vitest/config";

/**
 * `apps/migrate` is a bare directory entry in the root `vitest.workspace.ts`,
 * so before this file existed it inherited vitest's *defaults* —
 * `testTimeout: 5000` — while every other Postgres-touching project in the
 * workspace was explicitly given `hookTimeout: 30000` (see the `dbHookTimeout`
 * comment there) precisely because real-database setup/teardown is real,
 * unavoidable work and this host's load is not steady.
 *
 * The migrate project needs that treatment more than any other, and needs it on
 * `testTimeout` rather than `hookTimeout`: each test creates an isolated
 * MariaDB fixture database *and* an isolated Postgres target, runs the core
 * migrations plus the plugin migrations against the latter, and drops both —
 * all inside the test body via `createIsolatedMysqlFixture()` /
 * `createIsolatedPgTarget()`, not in a `beforeAll` hook.
 *
 * Measured on this box: `orchestrator-idempotency.test.ts` takes ~1.1s per test
 * run on its own, but exceeded 5s under a full `npm run verify` with
 * `maxWorkers: 6`, which timed out 30 tests across 21 files — every one of them
 * a `Test timed out in 5000ms`, with no assertion failure and no connection
 * error anywhere in the run. 30s matches `dbHookTimeout` and leaves ~25x
 * headroom over the unloaded cost.
 */
export default defineConfig({
  test: {
    name: "@gl3/migrate",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
