# GL3 — working notes for Claude

GL3 is a TypeScript reimplementation of **Gangster Legends V2**, a PHP 5.6-era MySQL
browser game (PBBG) with a large installed base of live games. `SPEC.md` is the
source of truth for *what* to build. This file is the source of truth for *how* to
work in this repo without rediscovering things the hard way.

**Read before starting work:** `SPEC.md`, then `docs/STATUS.md` (where the project
is), then `docs/ENGINEERING-NOTES.md` (why the code looks the way it does).

---

## Current state

M0, M1, M2 and M3 are complete. M5 (plugin SDK) is in progress: the foundation
(SDK + loader + example) and the web page renderer have shipped; all nine
module ports have shipped (`ranks`, `notifications`, `news`, `bank`,
`bullets`, `travel`, `crimes`, `mail`, `gangs`) — M5's module-port track is
complete. The event-envelope blocker that unblocked the last of them is
**resolved** — `tx.events.publishCore` lets a plugin publish any of the 22
core `GameEvent` variants verbatim. `profile`, `leaderboard` and `jail`
remain deliberate non-ports — see `docs/STATUS.md`. **PvP combat** has since
shipped on `feat/pvp-combat`: the `combat` and `inventory` plugins plus core
hospital, the first gameplay cluster that is not a port, so its tests are the
only specification of its behaviour. The **item economy** has since shipped
on `feat/item-economy`: a per-location shop in the `inventory` plugin (its
first table and first migrations) and four web pages (`/inventory`,
`/shop`, `/combat`, `/hospital`). The **bounties** plugin has since shipped
on `feat/bounties`: kill contracts placed and claimed via the SDK filter
system's first live consumer (combat's `killResolved` filter point). The
**detectives** plugin has since shipped on `feat/detectives`: cross-location
hunting with a paid seeded search, time-gated reveal (in place of delayed
jobs), and live-location tracking; spec and tests are its behaviour record.
The **organized crime** plugin has since shipped on `feat/organized-crime`:
four-role heists (mastermind/driver/gunman/hacker) with buy-in escrow, a
leader-fired seeded BullMQ job resolving one shared outcome (equal-split payout
or mass jail), one-active-heist-per-player via a partial unique index, and a
heist-row-FOR-UPDATE-first lock order that shares no edge with the existing
three (gang↔player, location↔player, player↔player); spec and tests are its
behaviour record. **Admin + ABAC-lite authz** has since shipped on
`feat/admin-abac`: role→module grants (`role_module_access`) checked by
`hasPermission` in the SDK, first registered player becomes Administrator with
`*` (advisory-lock guarded), loader route tier `auth: "admin"`, `adminPages`
manifest field with a `table` view node, six plugin admin sections (travel
towns, bullets stock/price, inventory items+shop, crimes+ranks balance editing,
news post gate via the loader tier) plus core role management; the `roles`
grant is transitively equivalent to full admin. An **admin usability pass**
has since landed: no admin table shows a UUID any more (ids still travel as
every `select`'s `valueKey`, enforced by `test/admin-ids-hidden.test.ts`),
ranks and crimes gained create routes, and core roles gained create plus
per-module grant/revoke over every loaded plugin id — revoking from the
caller's own role is refused (`cannot_revoke_own_role`), the counterpart of
the existing `cannot_demote_self`. A **table-ownership correction** has since
landed: core migration `0007_relinquish_plugin_tables` drops `bounties`,
`detective_searches` and `combat_log`, which shipped in core `0000`/`0005`
only because the core schema predated the plugin migration runner — no core
code ever read or wrote any of them. The single plugin that consumes each now
owns and migrates it (`p_bounties_bounties`, `p_detectives_searches`,
`p_combat_log`), so five of fourteen plugins declare migrations rather than
two — and with the theft cluster's `0009_relinquish_car_tables` below, six of
fifteen. Their foreign keys moved with them, unlike `p_inventory_shop_stock` and
`p_oc_*` which have none: keeping them leaves the lock graph exactly as it was.
**Money ranks, backfire and weapon condition** have since shipped on
`feat/money-ranks-backfire`, the first of four clusters bringing
migrated-but-unread V2 tables into play: `money_ranks` becomes a public
profile bracket over cash+bank (the label is public, the figure never is) and
a second table on `/ranks`; `player_stats.backfire` becomes a lifetime counter
behind a new attacker-only `player.backfired` event; and
`p_combat_weapon_condition` (combat migration `0004`, no foreign keys) degrades
weapons over both time and use, scaling each weapon's declared
`backfireChance` as a multiplier so an explicit zero stays zero. Repair is a
gunsmith route in `combat`, not a shop route in `inventory`. **Car theft** has
since shipped on `feat/car-theft`, the second of the four clusters: the
`theft` plugin (steal by tier with a weighted draw from the tier's value
bracket, police chase on failure — escape or jail — and a location-gated
garage with sell/repair), core migration `0009_relinquish_car_tables` moving
`cars`, `theft_tiers` and `garage` out of core (`p_theft_cars`,
`p_theft_tiers`, `p_theft_garage`) — so **six** of fifteen plugins declare
migrations rather than five — theft's routes are locations-first through
`tx.locks.location` before `tx.locks.player`
(`test/theft-lock-order.test.ts`), and its two player-facing pages plus its
admin section are declared in the manifest rather than hand-written in
`apps/web`.
**M4 (migration CLI) is complete** — `apps/migrate`, all 33 plan tasks, both SPEC
§6 acceptance criteria proven (a three-run idempotency test over all 26 target
tables, and a real-Fastify login by a migrated V2 player with lazy argon2id
upgrade). 18 migrators, 8-phase pipeline, `id_map` UUIDv7 resolution, esbuild-
bundled bin. MariaDB 10.11.14 is installed natively and hosts test fixtures only.
Suite: **160 files / 1216 tests**, `npm run verify` exit 0. Note `apps/migrate`'s
25 test files need `MYSQL_ADMIN_URL` exported alongside `DATABASE_URL` and
`REDIS_URL` (see `.env.example`); without it they fail as a block on a missing
env var, which reads like 36 real failures.

`publishCore` is unrestricted by design: any installed plugin can publish any
core event to any audience, and plugin output is no longer identifiable on the
wire as `plugin.event`. Trust is granted at install time; there is no runtime
guard. See `docs/STATUS.md` and design §5.

Full detail, including how to start M4, is in `docs/STATUS.md`.

---

## Environment (this machine)

**Docker is not available.** PostgreSQL 16.14 and Redis 7.0.15 run natively as
system services. `docker-compose.yml` stays in the repo as the documented path for
machines that do have Docker, but do not try to use it here.

**Container images are built in CI only.** `Dockerfile.server` and
`Dockerfile.web` (plus `apps/web/serve.mjs`, the zero-dep static server the web
image runs) cannot be built or validated on this machine — Docker Desktop's WSL
integration is off. The CI `images` job (`ci.yml`) builds both on every PR
(push disabled) and publishes them to GHCR on push to `main`. Every Dockerfile
change costs a CI round trip; `npm run typecheck` + `node apps/server/dist/index.js`
locally cover everything the image does *except* the container build itself.

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify          # typecheck + full suite — run this LOCALLY before committing
```

**Read `verify`'s exit code, not its summary.** Piping the run through
`grep`/`tail` discards npm's exit status, and the summary alone is not the
whole verdict: an unhandled rejection anywhere in the run makes vitest exit
non-zero while still printing `Tests 559 passed (559)`. That is exactly how the
gateway's missing `.catch` (`ws/gateway.ts`, fixed in `54423c8`) survived two
runs reported as green. Use `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"`
and treat any non-zero exit as a failure even when every test passed.

**GitHub CI does not run the integration suite.** Its `verify` job runs
`npm run verify:ci` (typecheck + the `@gl3/server:unit`, `@gl3/shared`,
`@gl3/plugin-sdk` and `@gl3/web` projects) with no Postgres or Redis service
containers. A green build proves the
tree typechecks and the no-DB tests pass — it is **not** evidence that the
integration suite passes. That check only exists on your machine, and it is on
you to run it. CI's second job, `images`, builds and (on `main`) pushes the two
container images — the one check that *cannot* run locally, since Docker is
unavailable here.

- Spare databases `gl3_a`..`gl3_d` exist for concurrent agents, but are **only
  migrated through `0002`** — anything touching an M3 table fails there with
  `42703 column "gang_id" does not exist`. Migrate one before relying on it.
- **This box has 32 CPUs but only ~3.8 GB RAM.** `maxWorkers` is capped at 6 in
  `vitest.config.ts` for that reason. Do not raise it.
- **Never run two full test suites at once** — including your own verification run
  alongside an agent's. Overlapping runs produce hook timeouts and cross-talk that
  look exactly like real regressions and have twice sent people chasing ghosts.
- **Never run `FLUSHALL` / `FLUSHDB`.** Redis is shared across every test file and
  every concurrent agent; flushing destroys sessions, cooldowns, rate-limit buckets
  and BullMQ state belonging to other work.
- MariaDB is **not** installed and is only needed for M4 (see `docs/STATUS.md`).
  GL3 itself is Postgres-only.

---

## The six rules that have each already caused a real bug here

1. **BullMQ is at-least-once.** Any worker that mutates the economy needs an
   idempotency key tied to `job.id`, inserted **first** inside the transaction. A
   seed makes the *outcome* reproducible; it does nothing to stop already-committed
   side effects being re-applied. M1 shipped a double-pay bug from exactly this.
   Reference: `crime_log.job_id` UNIQUE, used in `game/crimes/worker.ts`.

2. **Never check-then-act on Redis.** Use `SET NX EX`, `GETDEL`, or Lua. Two bugs
   have shipped from this shape (a rate limiter that could lock an IP out
   permanently, and a would-be replayable WebSocket ticket).

3. **Every balance movement goes through `applyBalanceChange`** (`economy/ledger.ts`)
   — one transaction, one ledger row, `bigint` throughout, no floating point.
   `sum(ledger) == balance` is enforced by `test/economy-invariant.test.ts`.

4. **Tests asserting on `game:events` must filter by their own `actorId`.** The
   channel is global across test files; matching on event type alone captures
   another file's traffic. Use `awaitOwnEvent()` from `test/helpers/events.ts`.
   Five files had this bug before it was found.

5. **Publish events only after the transaction commits.** Events are facts, not
   commands — never publish inside `db.transaction(...)`.

6. **A foreign key is a lock.** Inserting a row whose FK references another row
   takes `FOR KEY SHARE` on it, which conflicts with `FOR UPDATE`. No lock call
   appears in the code, so lock-order bugs here are invisible to a reader checking
   only the explicit locks — read the FKs too. Two deadlocks have shipped from
   this, both closed: the M3 gang case (membership routes locked `player_stats`
   first and reached `gangs` implicitly through a `gang_logs` insert, inverting
   the bank routes' order) and the travel case (travel locked `player_stats` FOR
   UPDATE and reached `locations` implicitly through the `location_id` FK,
   inverting bullets' location→player order). Every gang↔player path now goes
   through `lockGangAndPlayerForUpdate`; every location↔player path is
   locations-first — a single row via `lockLocationForUpdate` (bullets, and
   theft's steal/sell/repair through `tx.locks.location`) or
   several via `lockLocationsForUpdate`, which sorts them ascending (travel
   locks both its source and destination through it). Player↔player is the
   third pair, added by combat: `lockPlayersForUpdate` dedupes and sorts
   ascending in one statement, which is what makes A-shoots-B safe against
   B-shoots-A. Regression tests: `test/gang-lock-order.test.ts`,
   `test/travel-lock-order.test.ts`, `test/combat-lock-order.test.ts`,
   `test/theft-lock-order.test.ts` (`economy/ledger.ts`).

   Corollary for tests: a concurrency test whose participants all acquire locks via
   the same helper proves only the case that was already safe. The pre-existing
   deadlock test agreed on ordering *by construction* and stayed green through this
   bug for that reason.

---

## Conventions

- TypeScript strict. **No `any` in `packages/*`** — none, not even a cast. In
  `apps/*` prefer `unknown` plus a zod parse, and type guards over casts.
- ESM only; relative imports carry a `.js` extension despite `.ts` sources.
- Zod-validates **every** external boundary — HTTP bodies, **route params**, WS
  frames both directions, and bus messages. An unvalidated UUID param reaches
  Postgres and 500s instead of returning a clean 400.
- Money is `bigint` in Postgres and TypeScript, and crosses the wire as a **decimal
  string** (`MoneySchema`). Never a JSON number — that reintroduces floating point.
- Bigint column defaults must be written `` .default(sql`0`) ``, never
  `.default(0n)`; drizzle-kit's serialiser crashes on `BigInt`.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue
  or bus paths, ever.
- **A test that drives a plugin without `bootTestServer()` must run that
  plugin's migrations itself.** The template database every test file clones is
  built from *core* migrations only (`test/helpers/global-setup.ts`); plugin
  tables appear only when `loadPlugins` → `runPluginMigrations` runs. A file
  using `callPluginRoute` or `runPluginJob` directly needs an explicit
  `await runPluginMigrations(db, [thePlugin])`, or every test in it dies on
  42P01. Six plugins now own tables (`inventory`, `oc`, `bounties`,
  `detectives`, `combat`, `theft`), so this catches far more files than it
  used to — `economy-invariant.test.ts` and `detectives-worker.test.ts` are
  the worked examples.
- **A new *workspace-local* plugin package has eight registration sites, three
  of which fail silently or remotely** (plus a ninth that is per-*test-file*,
  below). All eight are consequences of living in
  the workspace; a plugin **installed from the registry** needs exactly two —
  a dependency in `apps/server/package.json` and `npm run plugins:generate`,
  which rewrites the generated `apps/server/src/plugins/installed-plugins.ts`.
  It needs no tsconfig reference (it ships built `dist/`), no `srcAliases`
  entry, and no Dockerfile COPY (it arrives through the existing `npm ci` in
  both stages). The eight below are:
  `packages/plugins/<id>/` itself, then:
  `apps/server/package.json` (+ `npm install`), `apps/server/tsconfig.json`
  references, root `tsconfig.json` references, `vitest.workspace.ts`
  `srcAliases`, `plugins/core-plugins.ts`, the old `app.ts` registration to
  delete, and **five separate COPY lines in `Dockerfile.server`**
  (`Dockerfile.server:54,74,75,112,127` for `bullets`; `travel` is the same
  shape — one per plugin per line, so `grep -c "packages/plugins/<id>" Dockerfile.server`
  is the fast check for a new port, expecting 5). Missing the
  `apps/server/tsconfig.json` reference or a Dockerfile COPY fails **only in
  CI** — the root tsconfig makes `npm run typecheck` pass regardless. Catch the
  first locally with `npx tsc --build --force apps/server/tsconfig.json`, the
  exact command the image build runs. Missing the `srcAliases` entry fails
  **nothing** and silently grades the last `tsc --build` against a stale
  `dist/`.
- **The ninth registration site is per test file, not per plugin:
  `vitest.workspace.ts` enumerates test files explicitly in each project's
  `include`.** A new `apps/server/test/*.test.ts` that is not listed there is
  invisible to every run — `npx vitest run <path>` exits 1 with "No test files
  found" and no other hint, and `npm run verify` stays green without it, so a
  file can sit committed and never execute. This bit three separate tasks on
  the `feat/car-theft` branch. New files go in the project matching what they
  touch (`@gl3/server:unit` for pure functions, `@gl3/server:db-only` /
  `redis-only`, the default `@gl3/server` project for `bootTestServer` /
  `testDb` files).
- **`@gl3/shared` and `@gl3/plugin-sdk` are published npm packages, not just
  workspace folders** — both live on `npm.gl3.dev` at `0.1.0`. Inside this repo
  every consumer resolves them through the workspace (`"@gl3/shared": "*"`), so a
  change to either is green in `npm run verify` while the registry copy stays
  stale, and a third-party plugin author installing `^0.1.0` gets the old one.
  **Any change to their public surface needs a version bump plus a republish**,
  `@gl3/shared` first — `pages.ts` imports *values* from it, not only types.
  Under `0.x`, `^0.1.0` resolves `>=0.1.0 <0.2.0`, so an additive change ships as
  a **patch** (`0.1.1`) and existing `"peerDependencies": { "@gl3/plugin-sdk":
  "^0.1.0" }` keeps working; a minor bump (`0.2.0`) breaks every one of those
  ranges and is a deliberate act, never the default. `files` in both manifests is
  load-bearing — `dist/` is gitignored, and without it npm publishes a package
  with no build output.
  The registry currently serves `@gl3/shared@0.1.1` (the `player.discharged`
  variant from commit `3b7e72e`, which landed after `0.1.0`) and
  `@gl3/plugin-sdk@0.1.0`. `@gl3/shared@0.1.0` is **gone** — `npm.gl3.dev` had no
  persistent volume until 2026-08-15 and lost its storage when one was attached,
  so both packages were republished onto the empty registry and only the versions
  above exist. A plugin pinning `@gl3/shared@0.1.0` exactly now 404s; `^0.1.0`
  resolves `0.1.1` and is unaffected, which is why the SDK needed no version bump
  of its own. **`@gl3/shared@0.1.2` has since been published** — the money-ranks
  cluster widened the surface additively (`player.backfired`,
  `WeaponConditionDtoSchema`, `RepairResponseSchema`, `moneyRankLabel`/`backfire`
  on `ProfileDto`, `moneyRanks` on `RankListResponse`), so it went out as a
  patch. The registry now serves `@gl3/shared` `0.1.1` and `0.1.2`, and
  `@gl3/plugin-sdk@0.1.0`.
- **Adding a variant to `GameEvent` breaks three places, and the third only
  fails under the integration suite.** The two obvious ones are the exhaustive
  switches in `apps/web` — `lib/eventCopy.ts` and `ws/invalidation.ts`, which
  fail loudly with TS2366. The third is the `CORPUS` drift guard in
  `apps/server/test/plugin-ctx-core-events.test.ts`: `CoreEventInput` is
  derived from `GameEventSchema`, so a new variant reaches the SDK for free
  and would reach the wire untested. `npm run typecheck` and the `@gl3/web`
  project both pass with it missing. A change that widens the union must run
  the whole of `npm run verify`; `player.backfired` shipped past two separate
  task reviews on this exact gap.
- Conventional Commits.
- **Plugin routes under `/api/admin/` must declare `auth: "admin"`** — enforced at
  boot by the loader. Core reserves the exact paths `/api/admin/plugins` and
  `/api/admin/roles`; plugins claim `/api/admin/<pluginId>`.

---

## Working method

Work is executed by subagents, one task at a time, against a written plan in
`docs/superpowers/plans/`. What has repeatedly mattered:

- **Verify every agent report against the repo yourself.** Reports have been wrong
  about test counts, and half-finished work has been reported as done. Running the
  suite yourself has caught failures an agent called green — twice.
- **"Went idle" does not mean finished.** Idle means momentarily not executing.
  Before replacing or overlapping an agent, *ask it*. Three separate incidents came
  from inferring an agent's state instead — once with three agents live on one file.
- **Ask agents to diagnose before fixing.** A plausible-sounding hypothesis
  (`argon2id is slow`) once nearly buried the real cause (a redundant 2.3-second
  `TRUNCATE`). Instrumentation beats intuition.
- **Demand proof a test can fail.** A green acceptance test that was never shown
  turning red proves nothing.
- **"Pre-existing failure" means pre-existing on `main`.** An agent reported two
  typecheck errors as pre-existing, having checked them out at a commit *inside*
  its own branch — where an earlier task had already introduced them. Any such
  claim gets re-checked against the merge base, not against whatever commit the
  agent happened to compare with.
- **"Changing this default affects nothing" needs the caller list, not the
  argument.** Enumerate every call site before accepting it. A default value's
  blast radius is exactly its callers, and that is cheap to enumerate and easy
  to hand-wave.
- **Flaky means broken.** Load-dependent failures here have always had real causes:
  shared BullMQ queue names, unfiltered event listeners, duplicated truncates.
