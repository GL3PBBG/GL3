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
      "@gl3/plugin-forum": fileURLToPath(
        new URL("./packages/plugins/forum/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-theft": fileURLToPath(
        new URL("./packages/plugins/theft/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-membership": fileURLToPath(
        new URL("./packages/plugins/membership/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-properties": fileURLToPath(
        new URL("./packages/plugins/properties/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-casino": fileURLToPath(
        new URL("./packages/plugins/casino/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-blackjack": fileURLToPath(
        new URL("./packages/plugins/blackjack/src/index.ts", import.meta.url),
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

// The same argument, on `testTimeout`: several files do real-database work
// inside test bodies — not hooks — and count it against vitest's 5s default.
// `theft-chase.test.ts` boots a whole `bootTestServer()` per test (settings
// are a boot-time snapshot, so each case's rows must land before its own
// boot); measured ~2s standalone, it exceeded 5s under a full `npm run
// verify` at `maxWorkers: 6` (5391ms) and timed out, taking the suite's
// exit code with it. This is the exact failure `apps/migrate/vitest.config.ts`
// hit and fixed the same way; `ledger.test.ts`'s 200-op test at 4.0–4.2s of
// a 5s budget is the same exposure waiting for a loaded run. Only the two
// Postgres projects get it — the unit and redis-only projects do no DB work.
const dbTestTimeout = 30000;

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
    // Mostly pure client modules — money/rank/error formatting and the
    // event→cache-key map — which run in node and need no DOM. A file that
    // renders (hooks via @testing-library/react) opts into a DOM per file
    // with a `// @vitest-environment jsdom` docblock; see
    // use-countdowns-ticker.test.ts. jsdom, not happy-dom, because DOMPurify
    // misbehaves under happy-dom's parser (markdown.test.ts explains). Full
    // component walkthroughs remain manual.
    test: {
      name: "@gl3/web",
      root: "./apps/web",
      include: ["test/**/*.test.ts"],
    },
    resolve: {
      alias: srcAliases.resolve.alias,
      // Vitest hardcodes `resolve.mainFields: []` for every project's SSR
      // module resolution (its own "vitest:project" plugin, deliberately —
      // "by default Vite resolves `module` field, which not always a native
      // ESM module"). That default is correct in general but makes
      // @letele/playing-cards@0.1.0 unresolvable here: it ships ONLY a
      // "module" field (no "main", no "exports"), so with mainFields: []
      // Node's own entry-point fallback runs and finds nothing. Restoring
      // "module" for this one project — not the whole workspace — lets
      // Vite's bundler-aware resolver find it the same way `vite build`
      // already does for the production bundle.
      mainFields: ["module", "main"],
    },
  },
  {
    test: {
      name: "@gl3/server:unit",
      root: "./apps/server",
      include: [
        "test/combat-resolve.test.ts",
        "test/combat-condition.test.ts",
        "test/combat-cooldown.test.ts",
        "test/combat-settings.test.ts",
        "test/effects-parity.test.ts",
        "test/config.test.ts",
        "test/mail-driver.test.ts",
        "test/facility-settings.test.ts",
        "test/password.test.ts",
        "test/admin-ids-hidden.test.ts",
        "test/admin-hidden-discriminator.test.ts",
        "test/admin-validate.test.ts",
        "test/plugin-map.test.ts",
        "test/plugin-dynamic.test.ts",
        "test/plugin-validate.test.ts",
        "test/plugin-point-names.test.ts",
        "test/rng.test.ts",
        "test/wealth-fee.test.ts",
        "test/rounds-settings.test.ts",
        "test/theft-settings.test.ts",
        "test/bullets-settings.test.ts",
        "test/theft-resolve.test.ts",
        "test/property-type-registry.test.ts",
        "test/casino-registry.test.ts",
        "test/item-effect-registry.test.ts",
        "test/casino-settings.test.ts",
        "test/blackjack-rules.test.ts",
        "test/blackjack-table-rules.test.ts",
        "test/blackjack-table-view.test.ts",
        "test/asset-driver-contract.test.ts",
        "test/asset-image-parse.test.ts",
        "test/asset-slots.test.ts",
      ],
    },
    ...srcAliases,
  },
  {
    test: {
      name: "@gl3/server:redis-only",
      root: "./apps/server",
      include: [
        "test/cooldown.test.ts",
        "test/plugin-ctx-cooldown.test.ts",
        "test/rate-limit.test.ts",
        "test/auth-verify-tokens.test.ts",
      ],
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
        "test/wealth-tax.test.ts",
        "test/schema.test.ts",
        "test/gang-ledger.test.ts",
        "test/plugin-migrate.test.ts",
        "test/plugin-runtime-schema.test.ts",
        "test/settings-load.test.ts",
        "test/bullets-restock.test.ts",
        "test/combat-log-schema.test.ts",
        "test/hospital-status.test.ts",
        "test/rounds-standings.test.ts",
        "test/assets-service.test.ts",
        "test/asset-sweep.test.ts",
      ],
      globalSetup,
      setupFiles: [isolatedDb],
      hookTimeout: dbHookTimeout,
      testTimeout: dbTestTimeout,
    },
    ...srcAliases,
  },
  {
    test: {
      name: "@gl3/server",
      root: "./apps/server",
      include: [
        "test/assets-routes.test.ts",
        "test/auth-reset.test.ts",
        "test/auth-verify.test.ts",
        "test/auth.test.ts",
        "test/bank.test.ts",
        "test/bounties-claim.test.ts",
        "test/bounties.test.ts",
        "test/bounties-lock-order.test.ts",
        "test/bullets-property.test.ts",
        "test/bullets.test.ts",
        "test/bullets-shop.test.ts",
        "test/bullets-lever-cap.test.ts",
        "test/bullets-restock-lock-order.test.ts",
        "test/casino-boot.test.ts",
        "test/casino-play.test.ts",
        "test/casino-act.test.ts",
        "test/casino-lock-order.test.ts",
        "test/casino-lobby.test.ts",
        "test/casino-rogue-game.test.ts",
        "test/casino-rogue-table.test.ts",
        "test/casino-tables.test.ts",
        "test/casino-table-money.test.ts",
        "test/casino-table-clock.test.ts",
        "test/casino-table-lock-order.test.ts",
        "test/casino-table-events.test.ts",
        "test/combat-backfire.test.ts",
        "test/combat-concurrency.test.ts",
        "test/combat-kill-filter.test.ts",
        "test/combat-kill.test.ts",
        "test/combat-lock-order.test.ts",
        "test/combat-notify.test.ts",
        "test/combat-repair.test.ts",
        "test/combat.test.ts",
        "test/core-filters.test.ts",
        "test/core-profile-extras.test.ts",
        "test/crime-worker-idempotency.test.ts",
        "test/crimes.test.ts",
        "test/crimes-widget.test.ts",
        "test/detectives-extras.test.ts",
        "test/detectives-worker.test.ts",
        "test/detectives.test.ts",
        "test/economy-invariant.test.ts",
        "test/extension-routes.test.ts",
        "test/facility-concurrency.test.ts",
        "test/facility-rosters.test.ts",
        "test/filter-subscriber-ctx.test.ts",
        "test/first-admin.test.ts",
        "test/forum-mod.test.ts",
        "test/forum-write.test.ts",
        "test/forum.test.ts",
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
        "test/hospital-checkin.test.ts",
        "test/hospital-concurrency.test.ts",
        "test/hospital-discharge-player.test.ts",
        "test/inventory.test.ts",
        "test/inventory-item-actions.test.ts",
        "test/item-effects.test.ts",
        "test/jail.test.ts",
        "test/jail-bail-bust.test.ts",
        "test/jail-escape.test.ts",
        "test/leaderboard.test.ts",
        "test/location-combat-modes.test.ts",
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
        "test/plugin-tx-timers.test.ts",
        "test/plugin-jobs.test.ts",
        "test/plugin-hospital-gate.test.ts",
        "test/admin-gate.test.ts",
        "test/admin-shell.test.ts",
        "test/admin-travel.test.ts",
        "test/admin-bullets.test.ts",
        "test/admin-detectives.test.ts",
        "test/admin-crimes.test.ts",
        "test/admin-ranks.test.ts",
        "test/admin-inventory.test.ts",
        "test/admin-theft.test.ts",
        "test/admin-membership.test.ts",
        "test/admin-properties.test.ts",
        "test/admin-rounds.test.ts",
        "test/admin-players.test.ts",
        "test/admin-economy.test.ts",
        "test/admin-facilities.test.ts",
        "test/theming.test.ts",
        "test/plugin-manifest-endpoint.test.ts",
        "test/plugin-routes.test.ts",
        "test/plugin-loader.test.ts",
        "test/online.test.ts",
        "test/players-search.test.ts",
        "test/presence.test.ts",
        "test/profile-extras-bounties.test.ts",
        "test/profile.test.ts",
        "test/ranks.test.ts",
        "test/rounds-finalize.test.ts",
        "test/rounds-ledger.test.ts",
        "test/rounds-lock-order.test.ts",
        "test/rounds-rollover.test.ts",
        "test/rounds-routes.test.ts",
        "test/rounds-snapshot.test.ts",
        "test/sentence-sweeper.test.ts",
        "test/sentence-sweeper-lock-order.test.ts",
        "test/sentence-sweeper-loop.test.ts",
        "test/shop-concurrency.test.ts",
        "test/shop.test.ts",
        "test/stats-endpoint.test.ts",
        "test/garage.test.ts",
        "test/properties-consumer-lock-order.test.ts",
        "test/properties-events.test.ts",
        "test/properties-lock-order.test.ts",
        "test/properties-pay-owner.test.ts",
        "test/properties-routes.test.ts",
        "test/properties-seizure.test.ts",
        "test/membership-benefits.test.ts",
        "test/membership-plugin.test.ts",
        "test/membership-gift.test.ts",
        "test/membership-extras.test.ts",
        "test/theft-chase.test.ts",
        "test/theft-lock-order.test.ts",
        "test/theft-routes.test.ts",
        "test/theft-tiers.test.ts",
        "test/travel-bullet-price.test.ts",
        "test/travel-lock-order.test.ts",
        "test/travel.test.ts",
        "test/ws.test.ts",
        "test/acceptance/**/*.test.ts",
      ],
      globalSetup,
      setupFiles: [isolatedDb, rateLimitIsolation],
      hookTimeout: dbHookTimeout,
      testTimeout: dbTestTimeout,
    },
    ...srcAliases,
  },
  "apps/migrate",
]);
