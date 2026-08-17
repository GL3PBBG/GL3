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
`apps/web`. **Properties** has since shipped on `feat/properties`, the third
of the four clusters: the `properties` plugin (buy/sell/claim on one
property per location, income accruing by whole hours from `last_claimed_at`
at `rate` capped by the `income.cap` setting, computed lazily at read and
never stored), core migration `0010_relinquish_properties` moving
`properties` out of core (`p_properties_properties`, with a unique index on
`location_id`) — so **seven** of sixteen plugins declare migrations rather
than six — the migrator stamps owned rows' `last_claimed_at` to migration
time so migrated owners accrue from the move, not 2015; `plugin_id` is a
dormant flavour label (stored, listed, admin-editable, selects nothing);
sell pays `cost + accrued` and `profit` is lifetime paid-out, not a claimable
pool; its routes are locations-first (`tx.locks.location` before
`tx.locks.player`, `test/properties-lock-order.test.ts`); its player page is
hand-written in `apps/web` (spec-mandated) while its admin section is a
manifest-declared `adminPages` table + forms; three events (`bought`,
`sold`, `income`) publish to the acting player with
`invalidates: ["properties", "me"]`.
**Rounds** has since shipped on `feat/rounds`, a seasonal scoring window and,
unlike the four preceding clusters, **core rather than a plugin** — there is
no relinquish migration and the plugin migration count stays seven of
sixteen. `ensureCurrentRound` settles lazily at read time under
`pg_advisory_xact_lock(7461002)`, no cron: a live already-snapshotted round
returns immediately with no transaction, and an ended round is frozen into
`round_entries` (the hall of fame — there is no separate winners table),
paid out in `points` (the one balance with no leaderboard ZSET and no
faucet, so a round's prize cannot move any board the next round measures),
published, and rolled to its successor, all under the one lock so N
concurrent settlers produce one settle and N−1 no-ops. Two new core
`GameEvent` variants, `round.started` and `round.finished`, ship in core
migration `0011_round_entries` alongside `round_entries` and its two
cascade FKs — the fourth place a new variant must reach turned out to be
`packages/shared/test/events.test.ts`'s own hardcoded census, missed by the
plan and caught only under the whole-tree suite (see the four-places note
below). `@gl3/shared` took an additive patch bump to `0.1.4` for the new
events plus `dto/rounds.ts`; `@gl3/plugin-sdk` needed none.
**Properties as franchises** has since shipped on `feat/properties-franchise`,
replacing the flat-rate income model from the properties cluster above with
V2's real mechanic, read from source after the fact (`SPEC.md:75` and `:165`
named the owner column `PR_owner`; it is `PR_user`, and the M4 migrator's
matching defect — a live bug independent of this cluster — is fixed in the
same branch). `plugin_id` is now live: the table's key moved from
`unique(location_id)` to `unique(location_id, plugin_id)`, so a casino and a
bullet factory coexist in one town, each declared via a new manifest field
(`providesProperties`) collected into a registry on **every** plugin's ctx
(`ctx.propertyTypes`, spec amended in place to say so). `rate` and
`last_claimed_at` are gone along with the claim and sell routes — there is no
clock any more. Income is consumer-paid: `cost` is reinterpreted as the
owner's lever (bullets reads it as price-per-bullet, falling back to the
location's own price when unset), and `@gl3/plugin-properties` exports
`ownerAt`/`payOwner` for any plugin willing to pay a franchise owner. `bullets`
is the first consumer — a dependency on `@gl3/plugin-properties`, the second
plugin→plugin dependency edge after `bounties`→`combat` — paying the owner
half of every bullet sale. Seizure on death **disowns** a victim's properties
game-wide rather than transferring them to the shooter (the shooter already
takes the kill's payout); it notifies via `tx.notify` rather than a plugin
event, because a `combat.killResolved` filter subscriber runs under the
*applying* plugin's ctx, so a `tx.events.publish` there would be mislabelled
as combat's. `drop` shipped with no refund, matching V2's DELETE; it now pays
back **half** the declared price and the page confirms first (see the
property-board note below). `@gl3/shared` took an additive patch bump to `0.1.5`
(`PropertyRowSchema`/`PropertyListResponseSchema` change shape); `@gl3/plugin-
sdk` took its first-ever bump, `0.1.1`, for `providesProperties` and
`ctx.propertyTypes`.
**The casino and blackjack** have since shipped on `feat/casino-blackjack`,
SPEC §6's v1.1 stub filled at last. Two packages, and the split is
load-bearing: `@gl3/plugin-casino` is the hub (the `p_casino_sessions` table,
escrow, payout, house resolution, the lobby) and declares **no** property
type, while `@gl3/plugin-blackjack` is the first game — pure rules, no tables,
no routes — and declares the house through `providesProperties`, which is what
makes a migrated V2 database's `plugin_id = 'blackjack'` rows light up on
install. So **eight of eighteen plugins declare migrations** rather than seven
of sixteen, and a game plugin owns no tables by design: its state is opaque
jsonb in the session row. A game registers through a filter point
(`games = filterPoint<GameDef[]>("casino.games")`, `bounties → combat`'s
shape) rather than a manifest field, so the extension point costs no SDK
surface — at the price of request-time rather than boot-time id validation.
`GameDef` is `start`/`act`/`settle`/`view`, all pure: a game returns a payout
FIGURE and the hub writes every ledger row, but that boundary only holds
because the hub BOUNDS the figure (`resolvePayout` clamps to
`maxPayoutMultiplier × wager` and refuses a negative one; a negative
`wagerDelta` and a non-finite multiplier are refused too), and a game's own
throw becomes a clean 400 rather than a 500. Money follows V2 exactly (the
wager escrowed to the owner at `play`, the payout debited from them at
settle — the owner is the house and can lose); `assertHouseCanCover` runs
before the wager is taken and again on every raise, because `payOwner` clamps
a debit to the owner's cash and would otherwise short-pay a winner in
silence. `property_id` is frozen at `play` and `act` settles against that row,
which pins the row and not the person — a `transfer` still hands the open
position over. Casino is a locations-first cluster: `tx.locks.location` → ONE
sorted `tx.locks.player([player, owner])` → the session row `FOR UPDATE`. No
events per hand (one per blackjack hand floods the feed), so no new
`GameEvent` variant. `@gl3/shared` went to `0.1.6` and `@gl3/plugin-sdk` to
`0.1.2` and then `0.1.3`; all three are published.
**Bullet restock** has since shipped on `feat/bullets-restock`: V2's hourly
`restock()` was never ported, so `bullet_stock` only ever drained. It is now
lazy under `pg_advisory_xact_lock(7461003)` (no cron — a core plugin cannot
declare jobs), fired by a new `GET /api/bullets/shop`, which had to be a *read*
because the page disables the buy button at zero stock. It takes every location
row `ORDER BY id FOR UPDATE`, ascending, which is a new edge in the lock graph
(`test/bullets-restock-lock-order.test.ts`, demonstrated red against `desc`).
V2's five options became admin-editable settings — `max_buy` and `max_cost`,
the latter both rejected at lever-set through a new `properties.leverSet`
filter point and clamped when charged — and a subscriber there **cannot** read
its own settings namespace, because `runFilterChain` passes the *applying*
plugin's ctx (the events mislabelling trap, now on record for settings too).
`migrateSettings` gained a rename map for V2's six flat bullet keys.
`@gl3/shared` → `0.1.7`, published — the registry now serves `0.1.1`
through `0.1.7`.
**The property board, the drop refund and the bankruptcy takeover** have since
landed on top of those two clusters: `GET /api/properties` lists only the town
the caller is standing in (both the real rows and the synthesised buyable
ones), so a property owned elsewhere is not listed at all — its
lever/transfer/drop/reset routes are not location-gated and still work;
`drop` answers `200 { refund }` paying `price / 2n` back, with a two-step
confirm in the page rather than `window.confirm`; and a casino payout the
house cannot cover now hands the TABLE to the winner via
`takeOverFrom` (`@gl3/plugin-properties`), which refuses unless a
`FOR UPDATE` re-read proves the expected owner still holds the row — an
unowned house is a faucet and cannot go bankrupt, and nobody seizes their own
table. It sits in casino's `settleSession`, so every future game inherits it.
`@gl3/shared` → `0.1.8` for the optional `houseSeized` step field, **published**
to `npm.gl3.dev` (which now serves `0.1.1` through `0.1.8`).
**M4 (migration CLI) is complete** — `apps/migrate`, all 33 plan tasks, both SPEC
§6 acceptance criteria proven (a three-run idempotency test over all 26 target
tables, and a real-Fastify login by a migrated V2 player with lazy argon2id
upgrade). 18 migrators, 8-phase pipeline, `id_map` UUIDv7 resolution, esbuild-
bundled bin. MariaDB 10.11.14 is installed natively and hosts test fixtures only.
Suite: **195 files / 1499 tests** as of `feat/casino-blackjack`, backed by a
bare `npm run verify` on that branch that **exited 0** with no unhandled
rejections. **The run takes ~270s, down from ~1000s**, because `resetDb`
truncated one table per statement (1.32s against 41 *empty* tables — 39
separate WAL flushes) and now issues one `TRUNCATE a, b, c ... CASCADE` (0.25s);
~87 files call it, most per test. Profile before optimising here: argon2 is
42ms a hash and `bootTestServer` is already memoised per file, so the obvious
suspects are the wrong ones — the second time this repo has recorded that
exact red herring.
**Read the exit code from the process, not from a wrapper.** The gate run
before the green one was reported by the harness as "completed (exit code 0)"
while the real status was **1** — the command ended in `; echo "exit=$?"`, so
the shell returned `echo`'s status and one red test (`casino-lock-order`'s
ABBA case) would have shipped as green.
That failure is **open, not cleared**: a bare 500 on `lockPlayersForUpdate`
with no SQLSTATE, 5/5 green standalone and 3/3 green under eight-file
contention, with no `40P01`, no `PostgresError` and no dropped connection in
the log — so the cross-talk story that explains `properties-lock-order`'s
round-19 failure does not explain this one. Two failures of that same shape
are now on record. `plugins/routes.ts` logs the driver error's `cause`
(SQLSTATE, detail, table) from this branch on, which is the datum both
diagnoses lacked. Note the 3.5x speedup raises concurrency *density*, which is
a plausible reason a latent contention bug surfaced when it did.
**A concurrent session makes a run *void*, not failing** — the
properties-franchise cluster saw `1307 passed, zero failures, 22 files at
(0 test)` because another agent shared this machine's Postgres and Redis. Zero
failures with files reporting no tests is cross-talk, not a green suite; check
`pgrep -fa vitest` and `select datname from pg_database where datname like
'gl3_tmpl%'` before starting a gate run. See `docs/STATUS.md`'s
properties-franchise section.
Note `apps/migrate`'s
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

**While iterating, scope the run; at the merge gate, don't.** The full suite
takes many minutes, so `npm run verify:related` (or `npm run test:related --
<files>`) runs only the tests whose module graph reaches what this branch
changed. That is a real gear for the edit loop — but it is a module-graph tool
and it cannot see a guard that asserts against the *database* instead of
against an import. `apps/server/test/schema.test.ts` reads `pg_catalog` and
imports nothing from the migration that changes its counts, so no scoped run
of any kind will select it. The rounds cluster is the worked example: twelve
green task-scoped runs, then two drift guards failed on the first full run.
**The last run before a merge is the bare `npm run verify`.**

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
   theft's steal/sell/repair through `tx.locks.location`, and properties'
   buy/lever/transfer/drop/reset through `tx.locks.location` — `sell` and
   `claim` are gone, retired with the accrual clock on
   `feat/properties-franchise`) or
   several via `lockLocationsForUpdate`, which sorts them ascending (travel
   locks both its source and destination through it), and casino's
   `play`/`act` through `tx.locks.location` before ONE sorted
   `tx.locks.player([player, owner])` and then the session row `FOR UPDATE`. Player↔player is the
   third pair, added by combat: `lockPlayersForUpdate` dedupes and sorts
   ascending in one statement, which is what makes A-shoots-B safe against
   B-shoots-A — `test/properties-consumer-lock-order.test.ts` is the second
   player↔player regression after combat's own, proving a consumer plugin
   that calls `payOwner` (bullets, buying from an owned factory) locks both
   the buyer and the owner in the one sorted call rather than two, which
   `test/properties-lock-order.test.ts`'s ABBA case caught for `transfer`
   independently. Regression tests: `test/gang-lock-order.test.ts`,
   `test/travel-lock-order.test.ts`, `test/combat-lock-order.test.ts`,
   `test/theft-lock-order.test.ts`, `test/properties-lock-order.test.ts`,
   `test/properties-consumer-lock-order.test.ts`,
   `test/casino-lock-order.test.ts` (`economy/ledger.ts`).

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
  42P01. Eight plugins now own tables (`inventory`, `oc`, `bounties`,
  `detectives`, `combat`, `theft`, `properties`, `casino`), so this catches far more files than it
  used to — `economy-invariant.test.ts`, `detectives-worker.test.ts` and
  `casino-rogue-game.test.ts` are the worked examples (the last needs
  `properties` migrated too, because `ownerAt` reads its table on every hand).
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
  patch. **`@gl3/shared@0.1.3` has since been published** — the properties
  cluster widened the surface additively (`PropertyRowSchema`,
  `PropertyListResponseSchema` for the hand-written web page), again a patch.
  **`@gl3/shared@0.1.4` has since been published** — the rounds cluster
  widened the surface additively (the `round.started` and `round.finished`
  `GameEvent` variants, plus `dto/rounds.ts`), again a patch, and
  `@gl3/plugin-sdk` needed no bump because its `CoreEventInput` is derived
  from `GameEvent` rather than restated. **The properties-franchise cluster
  bumped both manifests** — `packages/shared/package.json` to `0.1.5`
  (`PropertyRowSchema`/`PropertyListResponseSchema` changed shape: `accrued`/
  `rate` out, `lever`/`price`/`typeName` in — breaking in shape but shipped as
  a patch under the same `0.x`-additive-only reasoning as every bump above)
  and `packages/plugin-sdk/package.json` to `0.1.1`, its **first bump ever**
  (`providesProperties` on the manifest, `ctx.propertyTypes` on every plugin's
  ctx). **Both have since been published**, with the user's approval, following
  this branch's commit. **The casino cluster published three more**:
  `@gl3/shared@0.1.6` (`dto/casino.ts`, plus the `cards` leaf that had shipped
  in the SDK's `ViewNodeSchema` and never in shared's `ViewNodeDtoSchema` — a
  real defect, since `PluginsPayloadSchema.parse` is all-or-nothing and a
  declared page carrying a `cards` node would have taken down the whole plugin
  payload), `@gl3/plugin-sdk@0.1.2` (that leaf, plus `installedPluginIds` on
  `PluginCtx`), and `@gl3/plugin-sdk@0.1.3`, which only tightens its own
  `"@gl3/shared"` range from `^0.1.0` to `^0.1.6`. That range documents the
  coupling and cannot enforce it — the parse that fails is in the browser
  bundle, whose copy of shared comes from `apps/web`'s own dependency, not the
  SDK's. The guard that does enforce it is
  `packages/plugin-sdk/test/view-node-parity.test.ts`, which reads both
  leaf-kind sets back out of the schemas and runs in CI's `verify:ci`. The
  registry now serves `@gl3/shared` `0.1.1` through `0.1.6` and
  `@gl3/plugin-sdk` `0.1.0` through `0.1.3`.
- **Adding a variant to `GameEvent` breaks four places, and none of the last
  two is a type error.** The two obvious ones are the exhaustive switches in
  `apps/web` — `lib/eventCopy.ts` and `ws/invalidation.ts`, which fail loudly
  with TS2366. The third is the `CORPUS` drift guard in
  `apps/server/test/plugin-ctx-core-events.test.ts`: `CoreEventInput` is
  derived from `GameEventSchema`, so a new variant reaches the SDK for free
  and would reach the wire untested. **It needs Postgres and Redis, so it
  fails only under the integration suite** — `npm run typecheck`, the
  `@gl3/web` project and CI's `verify:ci` all pass with it missing.
  `player.backfired` shipped past two separate task reviews on this exact gap.
  The fourth is the hardcoded census `Set` in
  `packages/shared/test/events.test.ts`, which asserts the complete list of
  core event names against `GameEventSchema.options`. That one runs in the
  `@gl3/shared` project, so CI does catch it — but `npm run typecheck` does
  not, and it is a *separate* list from the `CORPUS` entries, so updating one
  never updates the other. A change that widens the union must run the whole
  of `npm run verify`; the rounds cluster hit the fourth place after twelve
  green task-scoped runs.
- **A core migration that adds a foreign key or an index breaks
  `apps/server/test/schema.test.ts`.** It counts every FK by `ON DELETE` rule
  and every non-primary-key index in `public`, with a comment block tracing
  each number to the migration that moved it. The counts are a drift guard, so
  the fix is always to restate them and extend the comment — never to loosen
  the assertion. It lives in `@gl3/server:db-only`, so like the `CORPUS` guard
  it fails only under the integration suite; `0011_round_entries` moved 34→36
  FKs (two cascades) and 27→29 indexes and was caught nowhere else.
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
