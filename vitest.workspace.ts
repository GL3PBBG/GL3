import { fileURLToPath } from "node:url";
import { defineWorkspace } from "vitest/config";

// Resolve the workspace packages to their TypeScript sources, not their
// dist/ — dist is a build artifact that can go stale relative to src (it
// only rebuilds via `tsc --build`, which `npx vitest` never triggers), so
// resolving to dist here would let a stale build pass tests with a false
// green. Runtime (apps/server/src/index.ts, the built server) is
// unaffected: these aliases only apply inside these vitest projects.
//
// Both packages ship a populated dist/, so a missing entry here does not
// fail loudly — it silently grades the last `tsc --build`. Every workspace
// package a test can import therefore needs a key, and they must all live
// in this one object: spreading two `{ resolve: { alias } }` objects into a
// project would have the second `resolve` replace the first wholesale, and
// the lost aliases would again fall back to dist without erroring.
const srcAliases = {
  resolve: {
    alias: {
      "@gl3/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@gl3/plugin-sdk": fileURLToPath(
        new URL("./packages/plugin-sdk/src/index.ts", import.meta.url),
      ),
      "@gl3/hello-plugin": fileURLToPath(
        new URL("./examples/hello-plugin/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-ranks": fileURLToPath(
        new URL("./packages/plugins/ranks/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-notifications": fileURLToPath(
        new URL("./packages/plugins/notifications/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-news": fileURLToPath(
        new URL("./packages/plugins/news/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-bank": fileURLToPath(
        new URL("./packages/plugins/bank/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-bullets": fileURLToPath(
        new URL("./packages/plugins/bullets/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-crimes": fileURLToPath(
        new URL("./packages/plugins/crimes/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-travel": fileURLToPath(
        new URL("./packages/plugins/travel/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-mail": fileURLToPath(
        new URL("./packages/plugins/mail/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-gangs": fileURLToPath(
        new URL("./packages/plugins/gangs/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-inventory": fileURLToPath(
        new URL("./packages/plugins/inventory/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-combat": fileURLToPath(
        new URL("./packages/plugins/combat/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-bounties": fileURLToPath(
        new URL("./packages/plugins/bounties/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-oc": fileURLToPath(
        new URL("./packages/plugins/oc/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-detectives": fileURLToPath(
        new URL("./packages/plugins/detectives/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-theft": fileURLToPath(
        new URL("./packages/plugins/theft/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-theft/resolve": fileURLToPath(
        new URL("./packages/plugins/theft/src/resolve.ts", import.meta.url),
      ),
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
  {
    test: {
      name: "@gl3/shared",
      root: "./packages/shared",
      include: ["test/**/*.test.ts"],
    },
    ...srcAliases,
  },
  {
    test: {
      name: "@gl3/plugin-sdk",
      root: "./packages/plugin-sdk",
      include: ["test/**/*.test.ts"],
      // Explicit tsconfig: vitest's default is the nearest tsconfig.json,
      // whose `include` is `src/**/*` (deliberately — it's also the build
      // config), so no test file ever entered the tsc program and
      // `.test-d.ts` files typechecked as vacuously clean regardless of
      // content. tsconfig.test.json adds `test/**/*.test-d.ts` only —
      // NOT all of `test/**`, which would pull in ordinary `.test.ts` files
      // whose deliberate zod-negative-input tests aren't meant to satisfy
      // strict typechecking.
      typecheck: { enabled: true, tsconfig: "tsconfig.test.json" },
    },
    ...srcAliases,
  },
  {
    // Pure client modules only — money/rank/error formatting and the
    // event→cache-key map. No jsdom and no component rendering: everything
    // here is a function of its arguments, which is why it needs neither a
    // DOM nor a new dependency. Anything needing a rendered component belongs
    // in the manual walkthrough until this project grows a DOM environment.
    test: {
      name: "@gl3/web",
      root: "./apps/web",
      include: ["test/**/*.test.ts"],
    },
    ...srcAliases,
  },
  {
    test: {
      name: "@gl3/server:unit",
      root: "./apps/server",
      include: [
        "test/combat-resolve.test.ts",
        "test/combat-condition.test.ts",
        "test/combat-settings.test.ts",
        "test/effects-parity.test.ts",
        "test/config.test.ts",
        "test/password.test.ts",
        "test/admin-ids-hidden.test.ts",
        "test/admin-hidden-discriminator.test.ts",
        "test/admin-validate.test.ts",
        "test/plugin-map.test.ts",
        "test/plugin-validate.test.ts",
        "test/rng.test.ts",
        "test/theft-settings.test.ts",
        "test/theft-resolve.test.ts",
      ],
    },
    ...srcAliases,
  },
  {
    test: {
      name: "@gl3/server:redis-only",
      root: "./apps/server",
      include: ["test/cooldown.test.ts", "test/plugin-ctx-cooldown.test.ts", "test/rate-limit.test.ts"],
      // No rateLimitIsolation setupFile: neither file boots a server or
      // exercises the real ratelimit:register:*/ratelimit:login:* keys —
      // rate-limit.test.ts drives tokenBucket() directly against its own
      // randomly-named buckets, so the shared-Redis collision this setupFile
      // guards against doesn't apply here.
    },
    ...srcAliases,
  },
  {
    test: {
      name: "@gl3/server:db-only",
      root: "./apps/server",
      include: [
        "test/ledger.test.ts",
        "test/schema.test.ts",
        "test/gang-ledger.test.ts",
        "test/plugin-migrate.test.ts",
        "test/plugin-runtime-schema.test.ts",
        "test/settings-load.test.ts",
        "test/combat-log-schema.test.ts",
        "test/hospital-status.test.ts",
      ],
      globalSetup,
      setupFiles: [isolatedDb],
      hookTimeout: dbHookTimeout,
    },
    ...srcAliases,
  },
  {
    test: {
      name: "@gl3/server",
      root: "./apps/server",
      include: [
        "test/auth.test.ts",
        "test/bank.test.ts",
        "test/bounties-claim.test.ts",
        "test/bounties.test.ts",
        "test/bounties-lock-order.test.ts",
        "test/bullets.test.ts",
        "test/combat-backfire.test.ts",
        "test/combat-concurrency.test.ts",
        "test/combat-kill-filter.test.ts",
        "test/combat-kill.test.ts",
        "test/combat-lock-order.test.ts",
        "test/combat-repair.test.ts",
        "test/combat.test.ts",
        "test/crime-worker-idempotency.test.ts",
        "test/crimes.test.ts",
        "test/detectives-worker.test.ts",
        "test/detectives.test.ts",
        "test/economy-invariant.test.ts",
        "test/first-admin.test.ts",
        "test/gang-bank.test.ts",
        "test/gang-invites.test.ts",
        "test/gang-lock-order.test.ts",
        "test/gang-members.test.ts",
        "test/gang-membership.test.ts",
        "test/gang-transfer.test.ts",
        "test/gangs.test.ts",
        "test/gateway-routing-error.test.ts",
        "test/health.test.ts",
        "test/hospital.test.ts",
        "test/hospital-concurrency.test.ts",
        "test/inventory.test.ts",
        "test/jail.test.ts",
        "test/leaderboard.test.ts",
        "test/mail.test.ts",
        "test/money-ranks.test.ts",
        "test/news.test.ts",
        "test/oc-worker.test.ts",
        "test/oc-concurrency.test.ts",
        "test/oc.test.ts",
        "test/oc-ledger.test.ts",
        "test/oc-lock-order.test.ts",
        "test/notifications.test.ts",
        "test/plugin-ctx-core-events.test.ts",
        "test/plugin-ctx-port-prereqs.test.ts",
        "test/plugin-ctx-transaction.test.ts",
        "test/plugin-jobs.test.ts",
        "test/plugin-hospital-gate.test.ts",
        "test/admin-gate.test.ts",
        "test/admin-shell.test.ts",
        "test/admin-travel.test.ts",
        "test/admin-bullets.test.ts",
        "test/admin-crimes.test.ts",
        "test/admin-ranks.test.ts",
        "test/admin-inventory.test.ts",
        "test/plugin-manifest-endpoint.test.ts",
        "test/plugin-routes.test.ts",
        "test/plugin-loader.test.ts",
        "test/profile.test.ts",
        "test/ranks.test.ts",
        "test/sentence-sweeper.test.ts",
        "test/sentence-sweeper-lock-order.test.ts",
        "test/sentence-sweeper-loop.test.ts",
        "test/shop-concurrency.test.ts",
        "test/shop.test.ts",
        "test/theft-tiers.test.ts",
        "test/travel-lock-order.test.ts",
        "test/travel.test.ts",
        "test/ws.test.ts",
        "test/acceptance/**/*.test.ts",
      ],
      globalSetup,
      setupFiles: [isolatedDb, rateLimitIsolation],
      hookTimeout: dbHookTimeout,
    },
    ...srcAliases,
  },
  "apps/migrate",
]);
