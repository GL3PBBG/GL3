# GL3 project status

Last updated: 2026-08-10, M5 stage 4 (core-event publishing + `news` port) outcome recorded.
Branch: `feat/plugin-core-events` (forked from `main` at `102079c`).

---

## Milestones

| Milestone | State | Notes |
|---|---|---|
| **M0 Scaffold** | ✅ complete | Monorepo, CI, docker-compose, all 32 tables migrated |
| **M1 Auth + vertical slice** | ✅ complete | Acceptance criterion proven end to end |
| **M2 Core loop parity** | ✅ complete | `sum(ledger) == balance` gate passing |
| **M3 Social** | ✅ complete | Both SPEC §6 checkmarks proven end to end |
| **M4 Migration CLI** | 📋 planned, blocked | 33 tasks — needs a MariaDB install (below) |
| **M5 Plugin SDK** | 🚧 in progress | Foundation + web renderer shipped. The event-envelope blocker is resolved (`tx.events.publishCore`); three of twelve module ports shipped (`ranks`, `notifications`, `news`); the six remaining pending ports are now unblocked. `profile`/`leaderboard`/`jail` are deliberate non-ports |

**Suite: 70 files / 571 tests**, green across repeated back-to-back runs.

---

## What actually works today

A player can register (argon2id) or log in with a **legacy V2 password**, which is
transparently upgraded to argon2id on first successful login. They receive a session
token, and a separate short-lived single-use ticket for the WebSocket handshake.

They can commit a crime: the request validates, atomically claims a Redis cooldown,
and enqueues a BullMQ job carrying a pre-generated seed. A worker resolves the
outcome in one Postgres transaction — payout through the ledger, exp, possible rank
promotion with its cash reward, possible jail sentence — then publishes a validated
event after commit. The WebSocket gateway fans it out by audience, and the React
client renders it live.

They can also bank cash, travel between locations (paying a fare), and buy bullets
from a location's shared stock. Leaderboards are Redis sorted sets rebuilt from
Postgres on boot. Jailed players are blocked from crimes and travel.

They can found a gang and run it: invite players (the invitee is notified live over
the WebSocket), accept or decline, leave, be kicked, and hold granular permissions
granted by the boss. The gang has its own bank — deposits and withdrawals move money
between a player and the gang, both sides ledgered in one transaction. Every
membership change appends a gang log row.

They can also send threaded mail, read and mark notifications, view any player's
public profile, and read game news.

Every balance movement anywhere is an append-only ledger row inside the same
transaction as the balance update.

**Every path touching a (gang, player) pair takes both rows through
`lockGangAndPlayerForUpdate`**, which orders them by UUID string comparison. That is
the single global lock order, and it is not optional: the membership routes
originally locked `player_stats` first and reached the `gangs` row implicitly (the
`FOR KEY SHARE` Postgres takes when a `gang_logs` or `gang_members` FK is checked),
which inverted the bank routes' order and deadlocked them — `40P01`, surfacing as an
HTTP 500 on a well-formed request. `test/gang-lock-order.test.ts` is the regression
test. `POST /api/gangs` is the one documented exemption, and only because it INSERTs
its own `gangs` row in the same transaction under a fresh uuidv7, so no other
transaction can want a lock on a row it cannot see.

---

## What M3 shipped

All 10 tasks of `docs/superpowers/plans/2026-08-07-gl3-m3-social.md` are complete:
gangs (create / invite / roles / bank / logs), mail, notifications, profile, and
game news.

**Acceptance criterion (SPEC §6) — met.** `test/acceptance/m3-acceptance.test.ts`
proves both halves in one flow: a gang is founded, the invitee is notified live over
the WebSocket, the invite is accepted, and a bank deposit and withdrawal reconcile
`sum(transactions) == gangs.bank` at the property level rather than trusting the
HTTP response body. Both assertions were demonstrated failing against deliberately
broken code before being accepted.

## M5 Plugin SDK — in progress

The plugin SDK lets gameplay modules be built *on* it rather than refactored into
it later. Design: `docs/superpowers/specs/2026-08-09-plugin-sdk-design.md`.

### What has shipped (foundation)

- **`packages/plugin-sdk/`** — `definePlugin`, `route`, `PluginError`, the `ctx`
  interfaces (`PluginCtx`/`PluginTx`), filter system (`filterPoint`/`on`), page
  schema types, event declarations. **Schema isolation is type-enforced**:
  `PluginDbTx` omits Drizzle's `query`, so a plugin physically cannot reach
  `players` or `transactions` (the `_NoRelationalQuery` compile-time guard).
- **`apps/server/src/plugins/`** — the loader (`validate → migrate → queues/
  workers → payload`), route registration (auth, jail-gate, zod params+body),
  job workers (seeded RNG, `plugin_job_runs` run-once idempotency),
  `GET /api/plugins`, and the migration runner (idempotent, tracked in
  `plugin_migrations`).
- **`examples/hello-plugin/`** — a third-party plugin that adds a table, route,
  page, and event, importing only `@gl3/plugin-sdk`. This is the M5 acceptance
  criterion, compiler-enforced.
- **All six CLAUDE.md rules are structural** in the ctx — a plugin cannot
  violate them by construction. See `packages/plugin-sdk/README.md`.
- **Schema:** migration `0004_plugin_runtime.sql` (`plugin_job_runs`,
  `plugin_migrations`).

Plugins load only when `PLUGIN_IDS` is set (comma-separated ids; default empty
= core-only boot, unchanged). Boot is a static import map in `index.ts` — a
dynamic `import(pluginId)` is deliberately not used so the dependency-direction
check stays compiler-enforceable.

### What has shipped (web renderer, Plan 2)

- **`packages/shared/src/dto/plugins.ts`** — the wire DTO for `GET /api/plugins`,
  carrying a second copy of the ten-kind view vocabulary. The duplication is
  deliberate: `@gl3/shared` may not depend on `@gl3/plugin-sdk`, so the DTO is
  self-contained. `packages/plugin-sdk/test/view-schema-contract.test.ts` is the
  drift guard — it imports both schemas and asserts they agree on a corpus of 12
  accepts and 18 rejects. Bounds (`MAX_VIEW_NODES`, `MAX_VIEW_DEPTH`) are walked
  over `children`/`items`/`rows`/`fields`.
- **`apps/web/src/plugins/`** — `render.ts` flattens a view tree to instructions,
  `PageRenderer.tsx` reconstructs panels and runs actions (per-control in-flight
  disable), `PluginPage.tsx` hosts a page keyed by id, `overrides.ts` is the
  core-page override map, `describe.ts` and `invalidation.ts` handle plugin
  events. Plugin pages route at `/plugins/:pageId`; a page's declared `path` is
  advisory in v1.
- **View actions are confined to the plugin's `basePaths`** at load
  (`apps/server/src/plugins/validate.ts`), and a path containing a `.` or `..`
  segment is rejected outright — `fetch` resolves those before the request
  leaves the page, so otherwise the approved string is not the sent string.
- **`apps/web/serve.mjs`** falls back to `index.html` for client routes, so a
  direct load of `/plugins/<id>` works in the container image.

### Module ports (Plan 3) — what shipped and what didn't

Branch `feat/plugin-sdk-module-ports`, five commits on top of `b26c68a` as of
the port work itself: `3abfa90` (ctx prereqs), `357c203` (ranks port),
`ca06091` (notifications port), `cefa3af` (fix: missing
`vitest.workspace.ts` `srcAliases` entry, see below), `7bba8fd` (this doc).
A final-review fix commit lands on top of those.

**Shipped:**

- **Task 0 (`3abfa90`)** — four ctx capabilities the ports needed:
  `tx.jail.sendToJail`, `tx.notify`, `tx.locks.location`,
  `tx.economy.applyExpAndRankUp`, plus a `RankUpResult` type exported from
  `@gl3/plugin-sdk`. **None of the four has a caller yet** — all four were
  built for the ports that shipped after them (`ranks`, `notifications`) or
  for the seven that are now deferred, and neither shipped port ends up
  calling any of them (`ranks` and `notifications` are read-mostly; the
  modules that would call `sendToJail`/`applyExpAndRankUp`/`locks.location`
  — crimes, travel, bullets — are among the deferred seven).
- **Task 1 (`357c203`)** — `ranks` ported to `packages/plugins/ranks`.
  Introduced `apps/server/src/plugins/core-plugins.ts` (`CORE_PLUGINS`):
  `buildApp` now default-loads it when a caller passes no `plugins`,
  registers an `onClose` teardown for only what it loaded, and throws at
  boot if a core plugin declares `jobs` (that path has no queue-name prefix,
  and shared BullMQ queue names have already caused a real cross-talk bug
  here — see CLAUDE.md rule 1's neighbors).
- **Task 4 (`ca06091`, fixed by `cefa3af`)** — `notifications` routes ported
  to `packages/plugins/notifications`. `notifications/service.ts`
  (`insertNotification`) stayed in core — it's consumed by other modules and
  reaches plugins as `tx.notify`. The follow-up fix: `vitest.workspace.ts`'s
  `srcAliases` object was missing a `@gl3/plugin-notifications` entry, so the
  specifier resolved to the gitignored `dist/` — a src-only edit was graded
  against the last `tsc --build` (a false green), and a clean tree failed at
  collection. **Every new workspace package a test can import needs a
  `srcAliases` entry in `vitest.workspace.ts`**, alongside that file's
  existing warning (below) that new test *files* need the explicit
  `include` lists. Both failure modes are silent.

**Deferred, and why:**

1. **The plugin-event-envelope blocker is resolved** (branch
   `feat/plugin-core-events`, design: `docs/superpowers/specs/2026-08-10-plugin-core-events-design.md`).
   `tx.events.publishCore` lets a plugin publish any core-typed `GameEvent`
   verbatim — `id`/`at` filled by the SDK, no `plugin.event` envelope — so a
   port's wire shape is unchanged from core's own emission. `news` is the
   first port built on it (below); `bank`, `bullets`, `travel`, `crimes`,
   `mail` and `gangs` are no longer blocked on an event design decision.
2. **`profile` not ported.** `PUT /api/profile` validates `avatarUrl` with a
   stored-XSS guard living in `@gl3/shared` (`dto/profile.ts` — scheme
   allowlist, embedded-credential rejection, URL normalization). A plugin
   may not import `@gl3/shared`, so every option was bad: duplicate a
   security control into the plugin, or leak a game-specific DTO into the
   generic SDK. It would also have dropped the `issues` array from the PUT's
   400 body. Left in core, deliberately.
3. **`leaderboard` and the `jail` route were already deliberate non-ports**
   in the plan (Redis-backed read aggregation; the central jail gate the
   route loader itself depends on). Their *capabilities* reach plugins via
   ctx (`tx.jail.sendToJail`) or the loader's `accessInJail` handling.

The two SDK gaps that used to be listed here as carry-forward work
(`PlayerSnapshot` lacking `username`; `LoadPluginsDeps` not derived from
`PluginCtxDeps`) are both closed — see `packages/plugin-sdk/src/ctx.ts` and
`apps/server/src/plugins/loader.ts`'s `LoadPluginsDeps` respectively.

### Core-event publishing + the `news` port (Plan 4)

Branch `feat/plugin-core-events`, forked from `main` at `102079c`. Design:
`docs/superpowers/specs/2026-08-10-plugin-core-events-design.md`.

- **`tx.events.publishCore`** — a plugin can now publish any of the 19 core
  `GameEvent` variants (everything `GameEventSchema` declares besides
  `plugin.event`) exactly as core itself would: same type, same fields, no
  wrapping envelope. `CoreEventInput` is derived from `GameEventSchema` (not
  restated), so a twentieth core variant reaches plugins with no SDK edit.
  `apps/server/test/plugin-ctx-core-events.test.ts` is the drift guard and
  covers ordering, rollback-discards-the-buffer (CLAUDE.md rule 5), and the
  leaderboard-buffering side effect below.
- **Leaderboard side effect.** `tx.economy.addExp` / `applyExpAndRankUp` now
  keep the Redis leaderboard current after a plugin-driven exp/cash change,
  the same way core's own economy paths do — buffered during the transaction
  and flushed only after commit.
- **`tx.notify`** now also publishes `notification.created`, addressed to the
  notified player (not the caller), alongside the existing row insert.
- **`news` ported** to `packages/plugins/news` — the first port built on
  `publishCore` (one event, `news.posted`, global audience, no ctx
  capability), chosen deliberately as the smallest case before `crimes` and
  `gangs`, which carry ordering and lock-order complexity. `apps/server/src/game/news/`
  no longer exists; `apps/server/test/news.test.ts` is unchanged and passes
  against the ported implementation.
- **Trust model — operator-facing.** `publishCore` is unrestricted: any
  loaded plugin may publish any core event to any audience once installed
  (trust is granted at install time, not per call — the same basis
  `tx.economy.applyBalanceChange` already relies on). Two consequences worth
  knowing before installing a third-party plugin: a plugin can publish
  `bank.transacted` with numbers that match no ledger row, and a plugin can
  address any core event to `audience: { kind: "global" }` and reach every
  connected socket. Before this change, a plugin's output was at least
  *identifiable* on the wire as `plugin.event`; `publishCore` removes that
  distinction, so a malicious or buggy plugin that could already corrupt
  state can now also lie about it convincingly. The mitigation is install-time
  review — there is no runtime guard beyond that. See design §5.

Six module ports remain: `bank`, `bullets`, `travel`, `crimes`, `mail`,
`gangs`. All are now unblocked.

## Starting M4

Read `CLAUDE.md` and `docs/ENGINEERING-NOTES.md` first, then unblock the MariaDB
install below.

Extract a task brief with:

```bash
.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/\
subagent-driven-development/scripts/task-brief \
  docs/superpowers/plans/2026-08-07-gl3-m4-migration-cli.md 1
```

### What M3 established that later work must not undo

- **Lock ordering is per row-pair, not one global rule for the whole app.** There
  are two orders and they do not conflict: gang↔player goes through
  `lockGangAndPlayerForUpdate` (UUID comparison); location↔player is the bullets
  shop's **location before player**. Travel is the mirror of bullets (player first,
  then `FOR KEY SHARE` on `locations` via the `location_id` update) and is inert
  only because it rejects destination == current before touching that row. Adding a
  path that locks a location and a player in a new order, or a gang and a player
  outside the helper, reintroduces SPEC §2.3's deadlock class.
- **An implicit FK lock counts as a lock.** Inserting a row whose FK references a
  locked row takes `FOR KEY SHARE` on it, which conflicts with `FOR UPDATE`. This is
  invisible in the code — no lock call appears — and it is what caused the M3
  deadlock. When reasoning about lock order, read the FKs, not just the lock calls.
- **`gang_permissions` rows are masked, not trusted.** `hasGangPermission` inner-joins
  `gang_members`, so a row for a non-member confers nothing. Three layers keep it
  that way: the grant route refuses a non-member target, accept-invite deletes rows
  that exist anyway, and the join denies whatever survives. Any future code path that
  inserts a `gang_members` row must delete the matching permission rows first.
- **Gangs have two balances** (`gangs.bank` and `gangs.cash`), preserved from V2's
  `G_bank` / `G_money`.
- **The `gang` audience** in the WS gateway resolves members via `gang_members`. The
  gateway routes purely on `event.audience` and knows nothing about features — keep
  game rules out of it.
- Mail is threaded (V2's `M_parent` → `thread_id`).
- **New test files must be added to `vitest.workspace.ts`.** The `include` lists are
  explicit; an unlisted file is silently never run and looks exactly like a green
  suite.

---

## M4 is blocked on one command from you

M4 builds the CLI that converts a live V2 **MySQL** database into GL3 Postgres. To
test a MySQL reader honestly, the tests need a MySQL-compatible server. Docker is
unavailable here, so the plan uses MariaDB as the wire-compatible substitute.

```bash
sudo apt-get install -y mariadb-server mariadb-client && sudo service mariadb start
```

`sudo` needs a password, so this has to be run by a human. Task 1 of
`docs/superpowers/plans/2026-08-07-gl3-m4-migration-cli.md` has the full setup.

**To be clear: GL3 remains Postgres-only.** `apps/server`, `apps/web` and
`packages/shared` have zero MySQL dependencies. `mysql2` appears only in the planned
`apps/migrate` package, and MariaDB only ever hosts a throwaway test fixture. The
data flow is one-way — V2 MySQL → GL3 Postgres — and the migrator is a one-shot
cutover tool.

---

## Container images

Two images build in CI (`ci.yml`, `images` job) and publish to GHCR on push to
`main`; on PRs they build only (`push: false`), which is the check that the
Dockerfiles compile. They cannot be built locally — Docker is unavailable here
(see CLAUDE.md), so CI is the only place the image is proven.

| Image | Dockerfile | Serves | Runtime env |
|---|---|---|---|
| `ghcr.io/rondlite/gl3-server` | `Dockerfile.server` | API + WS gateway (`apps/server/dist/index.js`) | `DATABASE_URL`, `REDIS_URL` (required — `loadConfig` throws), `PORT` (default 3000), `CORS_ORIGINS` (default is localhost; **must be a real origin**, the schema rejects `*`) |
| `ghcr.io/rondlite/gl3-web` | `Dockerfile.web` | The built Vite bundle via `apps/web/serve.mjs` | `PORT` (default 8080) |

Both are `node:22-alpine`, `linux/amd64`, multi-stage, and run as the `node` user.
`argon2` resolves its musl prebuild, so no build toolchain is needed. **Migrations
are not in the images** — `dist/db/migrate.js` exists as build output but is not
wired to the server CMD; schema changes remain an external operation. Ingress
(Rancher) terminates TLS and routes `/api` and `/ws` to the server image, so the
web image serves only the SPA's own assets.

---

## Known issues and watch items

**Open, deliberately deferred:**

- **`CORE_PLUGINS` grows a silent-drop surface.** A `buildApp` caller that passes
  an explicit `plugins` array gets *only* those plugins — every core plugin's
  routes are absent for that boot. `bootTestServer({ plugins: [...] })` is used by
  `plugin-manifest-endpoint.test.ts`, `plugin-routes.test.ts` and
  `plugin-loader.test.ts`. No test hits `/api/ranks` or `/api/notifications`
  under such a boot today, so nothing is broken — but each new core plugin widens
  the surface, and the failure mode is a silent 404 rather than an error.
- **Every core plugin must declare no `menu`, no `pages`, no `events`.**
  `plugin-manifest-endpoint.test.ts:87` asserts that a no-arg boot answers
  `GET /api/plugins` with exactly `{ menu: [], pages: [], events: [] }`. Since
  `buildApp` now default-loads `CORE_PLUGINS` on that path, the assertion holds
  only because the ported plugins (`ranks`, `notifications`) contribute nothing
  to the payload. That is a real constraint on future ports, currently enforced
  by nothing but this note and that test.
- **Ported GET routes open a transaction where the legacy route ran a bare
  SELECT.** No behaviour change; inherited from the ranks port's pattern and
  carried into notifications. A property of the ported-read pattern, to be
  decided once for all ports rather than per port.
- **The plugin loader's `loadSnapshot` inner-joins `player_stats`**, so a player
  row without a stats row would 401 where the legacy route returned 200/404.
  Unreachable today because registration writes both rows together.
- **The spare databases `gl3_a`..`gl3_d` are NOT migrated past `0002`.** Anything
  touching an M3 table fails there with `42703 column "gang_id" does not exist`.
  They are fine for M0–M2 probes and useless for anything newer. Migrate them before
  relying on one.
- **`GET /api/mail` and `GET /api/notifications` are unbounded and unpaginated.**
  Mail is the larger problem of the two: it returns full message bodies (up to 5000
  chars each), and mail volume will outgrow notification volume. Bound both before
  any real deployment.
- **Only kick × deposit has deadlock-regression coverage.** Leave, accept-invite and
  `PUT /permissions` were fixed in the same commit and are sound by the same
  argument, but no test proves them. If you edit those lock lines, that is the gap.
- **No unique constraint on `gang_invites (gang_id, invited_player_id)`.** Duplicate
  invites produce duplicate rows and duplicate notifications. Inert today because
  accepting clears all of the invitee's pending invites.
- **The public profile route is the only unauthenticated, un-rate-limited route in
  the app**, and it runs a four-table join per anonymous hit. Reviewed and accepted:
  the join is keyed on a primary key with at most one result row, so the exposure is
  amplification at request rate, not enumeration. Revisit before deployment.
- **`RegisterRequestSchema.email` has no explicit `noNulByte` guard.** It is safe
  only *incidentally*, because zod's `.email()` regex happens to reject NUL — verified
  independently across local-part, domain, leading and trailing positions. Fragile
  against a zod bump that loosens the regex.
- **Leaderboard scores above 2^53.** Redis sorted-set scores are IEEE doubles;
  balances are deliberately `bigint` because V2's signed-32-bit ceiling was a real
  problem in long-running games. Documented but *not enforced* — no GL3 value
  approaches it yet. Revisit before any real deployment; silent truncation would be
  a genuine defect for exactly the games that motivated `bigint`.
- **`ledger.test.ts`'s 200-op test runs 4.0–4.2s** against vitest's 5000ms default.
  It has never failed, but it is the closest remaining timing margin. Watch it.
- **`npm audit` reports dev-only findings**, all transitive via `vitest@2.1.9`
  (including one critical). Clearing them needs a vitest 2.x → 4.x major bump, which
  is a deliberate decision nobody has taken yet. Note that npm audit's *suggested*
  fix for the drizzle-kit findings is a **downgrade to 0.18.1 that would reintroduce
  a SQL-injection CVE** — do not follow it.

**Resolved, but the reasoning matters if you touch these areas:**

- Test databases are cloned from a pre-migrated **template** with
  `STRATEGY = WAL_LOG`. Postgres' default `FILE_COPY` serialises concurrent
  `CREATE DATABASE` (10.3s vs 0.28s for 14 clones).
- `vitest.workspace.ts` splits tests into four projects by actual need
  (`unit` / `redis-only` / `db-only` / full) so unit tests create no database at all.
- `hookTimeout` in the **root** `vitest.config.ts` is a **no-op** for workspace
  projects — it must be set per-project. (`maxWorkers`/`minWorkers` are pool-level
  and *do* apply from root.) This was proven empirically, not assumed.
- Leaderboard Redis keys are namespaced per `bootTestServer()` call; production
  keeps the global keys, which is correct there.
