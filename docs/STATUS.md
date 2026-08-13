# GL3 project status

Last updated: 2026-08-13, **M4 migration CLI complete** (all 33 tasks, both SPEC §6
acceptance criteria proven).
Branch: `feat/m4-migration-cli`.

---

## Milestones

| Milestone | State | Notes |
|---|---|---|
| **M0 Scaffold** | ✅ complete | Monorepo, CI, docker-compose, all 32 tables migrated |
| **M1 Auth + vertical slice** | ✅ complete | Acceptance criterion proven end to end |
| **M2 Core loop parity** | ✅ complete | `sum(ledger) == balance` gate passing |
| **M3 Social** | ✅ complete | Both SPEC §6 checkmarks proven end to end |
| **M4 Migration CLI** | ✅ complete | `apps/migrate` — 18 migrators, 8-phase pipeline, idempotent via `id_map`; both SPEC §6 criteria proven (below) |
| **M5 Plugin SDK** | 🚧 in progress | Foundation + web renderer shipped. The event-envelope blocker is resolved (`tx.events.publishCore`); nine of nine module ports shipped (`ranks`, `notifications`, `news`, `bank`, `bullets`, `travel`, `crimes`, `mail`, `gangs`) — the module-port track is complete. `profile`/`leaderboard`/`jail` are deliberate non-ports. **PvP combat** (`combat` + `inventory` plugins, core hospital), **item economy** (location shop, combat targets, four web pages), **bounties** (kill contracts, first live cross-plugin filter — `killResolved`), **detectives** (cross-location hunting, time-gated reveal, live-location tracking), **organized crime** (four-role heists, buy-in escrow, shared-fate seeded job), and **admin + ABAC-lite authz** (role-module grants, first-user admin, loader admin tier, six plugin admin sections + core role management) have since shipped |

**Suite: 141 files / 1025 tests**, `npm run verify` exit 0. (M4 added the 30 files /
57 tests of the `@gl3/migrate` project; the pre-M4 tree ran 111 / 968.)

The **admin usability pass** on top of that added one file and 27 tests:
`admin-ids-hidden` (8, a unit-project walk over every core `adminPages` view
asserting no `table` declares an id column), `admin-shell` +10 (role create,
module grant/revoke, the module list, the self-revoke lockout guard),
`admin-crimes` +5 and `admin-ranks` +4 (the new create routes). It also
retires the UUID columns from all seven admin tables, adds "Add rank" and
"Add crime" forms, and boxes `PageRenderer`'s forms (`.formCard`) after a
`align-items: center` on a label-above-input grid left every submit button
floating mid-field — which is how travel's "Add town" form was missed.

Note: 966 − 27 = 939, not the 927 recorded below. The pre-pass figure was
already stale (the commit that set it says 926, the table said 927); 939 is
what the tree actually ran at before this pass.

(The pre-`feat/admin-abac` baseline was 98 files / 845 tests, so admin + ABAC
added **12 new test files / 82 tests net**. The twelve new files:
`admin-validate` (8), `admin-gate` (5), `first-admin` (3), `admin-shell` (11),
`admin-travel` (5), `admin-bullets` (4), `admin-crimes` (5), `admin-ranks` (5),
`admin-inventory` (11), `admin-acceptance` (1), SDK `authz` (5), shared
`admin-sections-dto` (7) — 70 tests. The remaining 12 are *net additions* to
five files that already existed, not whole-file totals: SDK `manifest` +5
(adminPages normalisation and validation), SDK `pages` +3 (the `table` node),
SDK `view-schema-contract` +1 (one more `it.each` case, `table`), web
`plugins-render` +1 (table instruction), and `news` +2 — the news gate
refactor also absorbed the three original gate tests into the loader tier,
which is why its net is smaller than its additions.)

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

They can now shoot each other. A player equips a weapon and armor from their
inventory, then fires one shot per request at another player in the same
location — accuracy decides whether it lands, damage minus the target's armor
decides how much it takes off, and both sides get a `player.attacked` event
live over the WebSocket. A killing shot takes the victim's **on-hand** cash
(their bank is untouched) and puts them in hospital for a fixed sentence.
From hospital they can wait it out, use a heal item to restore health, or pay
cash to be discharged early — heal items restore health but do **not** end the
sentence.

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

### The `bank` port (Plan 5)

Design: `docs/superpowers/specs/2026-08-10-plugin-bank-port-design.md`. Plan:
`docs/superpowers/plans/2026-08-10-plugin-bank-port.md`.

- **`bank` ported** to `packages/plugins/bank`. `POST /api/bank/deposit` and
  `/withdraw` answer from the plugin; `apps/server/src/game/bank/` no longer
  exists. `test/bank.test.ts`'s `app.inject` block is unchanged and is the
  proof that paths, status codes, error strings, response bodies and the
  `bank.transacted` event are byte-identical.
- **No `schema.ts`.** Unlike `news` and `ranks`, this plugin mirrors no core
  tables: `actorName` comes from `ctx.player.username`, and both balances come
  from the two `applyBalanceChange` return values. Core's post-commit
  `SELECT cash, bank` and both its `recordScore` calls disappear — the latter
  absorbed by the ctx's leaderboard buffering (core-events design §B1), which
  `test/leaderboard.test.ts` now proves end to end.
- **`InsufficientFundsError` added to the SDK.** `tx.economy.applyBalanceChange`
  threw core's class, which lives in `apps/server` and so cannot be imported by
  a plugin package; the route loader maps only `PluginError`, so **every plugin
  overdraft was a 500**. `plugins/ctx.ts` now translates core's into the SDK's,
  which the plugin catches. Deliberately **not** mapped centrally by the loader:
  `bank`, `travel` and `bullets` answer 409 `insufficient_funds` but `gangs`
  answers 400 `insufficient_cash` (now `packages/plugins/gangs/src/index.ts`'s
  `depositRoute`), so a central mapping would have to change one of them.
  Only `applyBalanceChange` is wrapped — `InsufficientGangFundsError` has the
  identical gap and is deferred to the `gangs` port, which is the plan that
  can prove it end to end.
  **Closed by the `gangs` port** (Plan 10): `InsufficientGangFundsError` is
  now in the SDK and translated by `plugins/ctx.ts` the same way, proven end
  to end by `plugin-ctx-transaction.test.ts`'s overdraft case and by
  `gang-bank.test.ts` against the real route.
- **`callPluginRoute` test helper** (`test/helpers/plugin-route.ts`). Three core
  test files imported `performBankTransaction` directly — `news` had no such
  coupling, which is why `news.test.ts` needed no edit. They now drive the real
  plugin handler in-process, so `economy-invariant.test.ts`'s 1000-op
  `sum(ledger) == balance` sweep still covers bank's actual code path.
  `loadSnapshot` is exported from `plugins/routes.ts` rather than copied, so a
  test's ctx cannot drift from the real route's. The helper is explicitly **not
  the HTTP contract** — no jail gate, no auth, no `PluginError` → status
  mapping. `travel`, `bullets`, `crimes` and `gangs` face the same coupling and
  reuse it.
- **The gang bank routes are NOT part of this port.** `game/bank/` was
  player-only; the routes CLAUDE.md rule 6 describes are
  `POST /api/gangs/:gangId/bank/{deposit,withdraw}` (now
  `packages/plugins/gangs/src/index.ts`'s `depositRoute` and `withdrawRoute`),
  and they ship with `gangs`. Splitting them out would put gang↔player lock
  ordering under two owners — the split-brain shape M3's deadlock came from.

Five module ports remained: `bullets`, `travel`, `crimes`, `mail`, `gangs`. All
were unblocked. `bullets` and `travel` were the natural next two: single-player
money paths that reuse the SDK error and the helper with nothing new. `bullets`
went first, then `travel` — see both below.

**Carried forward from this branch's final review** — three accepted Minors,
none blocking, all worth closing when the next port touches the same code:

1. **`applyExpAndRankUp`'s zero-gain early return is untested.** The zero-gain
   guard exists on both `tx.economy.addExp` and `tx.economy.applyExpAndRankUp`
   (a zero gain is core's own no-op, so no `UPDATE` runs, so no row lock is
   taken — reading `player_stats` anyway would be an unlocked read that can
   `ZADD` a stale value over a newer one after commit). Only the `addExp` half
   has a test. `applyExpAndRankUp` is the branch that buffers *two* kinds
   (`exp` and `cash`), so it is the one with more to get wrong. `crimes` calls
   both on a failed crime and is the natural place to close this.
2. **The `news` GET route's ordering and cap are untested.**
   `apps/server/test/news.test.ts` covers an empty list and a single item, so
   neither `ORDER BY createdAt DESC` with more than one row nor the `limit(50)`
   cap is exercised. Pre-existing — it predates the port — but the handler is
   new code in `packages/plugins/news` now.
3. **`CorpusEntry` in `plugin-ctx-core-events.test.ts` collapses the union.**
   It is `Omit<CoreEventInput, …>`, i.e. the same non-distributing `Omit` that
   `OmitFromUnion` exists to avoid, which is why the corpus needs an
   `as CoreEventInput` cast at the call site. Plan-mandated verbatim, and the
   runtime `GameEventSchema.parse` is the real guard, so the cast is not
   load-bearing — but reusing `OmitFromUnion` there would remove it.

### The `bullets` port (Plan 6)

Design: `docs/superpowers/specs/2026-08-10-plugin-bullets-port-design.md`.
Three commits: `c58121e` (loader `retry-after` fix), `bfbc4a6` (the plugin
package), `2a2e59f` (the cutover).

- **`bullets` ported** to `packages/plugins/bullets`. `POST /api/bullets/buy`
  answers from the plugin; `apps/server/src/game/bullets/` no longer exists.
  `bullets.test.ts`'s `app.inject` block is unchanged bar the two additions
  below and is the proof that paths, status codes, error strings and response
  bodies are byte-identical.
- **First caller of `tx.locks.location`.** Task 0 of the module-ports plan
  (`3abfa90`) built four ctx capabilities with no caller at the time;
  `tx.locks.location` sat unused until this port. The location→player lock
  order (CLAUDE.md rule 6, "what M3 established" above) is now exercised, not
  merely documented — and the `travel` port has since closed the deadlock
  half `travel` used to own (see "Resolved" below). The concurrency test — a
  stock of 1, two simultaneous buyers — was demonstrated **failing** with
  the lock line commented out (both buyers succeeded, an oversell) before
  being restored to passing.
- **First plugin to write a core-owned column no ctx capability covers.**
  `player_stats.bullets` and `locations.bullet_stock` are written directly
  through `tx.db`, via mirrored schemas in the plugin's own `schema.ts`
  (column names and types matched to `db/schema/identity.ts` and
  `content.ts` by hand). `bank` routed every write through
  `tx.economy.applyBalanceChange`; `news` wrote only a table core no longer
  touches. Growing the SDK a `tx.inventory.addBullets` /
  `tx.locations.takeStock` pair was rejected — two members whose only caller
  is one plugin, the same objection that made `profile` a deliberate
  non-port. The consequence, stated plainly: schema isolation is
  compiler-enforced for relational queries (`PluginDbTx` omits Drizzle's
  `query`) and for money (`applyBalanceChange`), and is **convention** for
  everything else. A plugin that mirrors a table can write it.
- **The loader now sends `retry-after` on its 423.** Core's jail-gated routes
  always set the header alongside the body (`game/travel/routes.ts:42`,
  `game/crimes/routes.ts:55`); the plugin loader (`apps/server/src/plugins/routes.ts:33`)
  sent only the body, so a naive port would have silently dropped it — and
  the pre-fix test, asserting only `toMatchObject({ error: "jailed" })`,
  would have stayed green through the loss. Fixed in the loader in `c58121e`,
  ahead of the port itself, so `travel` and `crimes` inherit it for free. No
  plugin sets `accessInJail: false` today, so nothing else changes behaviour.
- **The cash leaderboard now updates on a purchase.** Core's bullets service
  never called `recordScore`; `tx.economy.applyBalanceChange` buffers one
  leaderboard write per changed kind and flushes after commit (core-events
  design §B1), so the ported route begins `ZADD`-ing the player's cash score
  where core did not. No opt-out was added, deliberately: a suppression flag
  would exist only to preserve a core inconsistency (`bank` and `crimes`
  record cash; `bullets` and `travel` did not), and every future port would
  have to decide which way to set it. Now asserted directly in
  `bullets.test.ts` rather than incidental.
- **A deliberate deviation from byte-identity, found in review.**
  `packages/plugins/bullets/src/index.ts` guards the `player_stats`
  UPDATE...RETURNING with `if (!fresh) throw new PluginError("no_location", 409)`.
  Core used a non-null assertion in the same spot, which would have thrown an
  uncaught TypeError — an HTTP 500 — had the row vanished. Effectively
  unreachable in both versions, since `applyBalanceChange` already locked and
  read that row moments earlier in the same transaction, and 409 is strictly
  safer than a crash — but it is a real deviation from the "byte-identical"
  claim the file's own header comment makes, recorded here rather than
  smoothed over.
- **The invariant sweep** (`economy-invariant.test.ts`) reports
  `succeeded.bullets = 190` of `attempted.bullets = 201` over its 1000-op run.

### The `travel` port (Plan 7)

Design: `docs/superpowers/specs/2026-08-10-plugin-travel-port-design.md`.

- **`travel` ported** to `packages/plugins/travel`. `GET /api/locations` and
  `POST /api/travel/:locationId` answer from the plugin;
  `apps/server/src/game/travel/` no longer exists.
- **`tx.locks.locations`** (Plan 7, Task 1) — a new ctx capability that
  locks several `locations` rows in ascending-id order, deduped, null-safe.
  `travel` locks both its source and destination rows through it before the
  player row, settling the location↔player lock order as locations-first in
  every path that touches both. The old `tx.locks.location` (single row)
  stays for `bullets`. Regression test: `apps/server/test/travel-lock-order.test.ts`
  — a hand-written raw-SQL adversary (see "Resolved" for why a real
  buy-vs-travel test cannot be built), shown red against the inverted order.
- **The closed defect is documented in "Resolved" below**, alongside the
  reason locking only the destination would have left the staleness half
  open.

### The `crimes` port (Plan 8)

Design: `docs/superpowers/specs/2026-08-10-plugin-crimes-port-design.md`. Five
commits: `f537ecf` (loader retry fix), `72f28e8` (scaffold), `8af0ff6`
(routes+job), `e88fe04` (test retarget), `66b47b7` (cutover).

- **`crimes` ported** to `packages/plugins/crimes`. `GET /api/crimes` and
  `POST /api/crimes/:crimeId/commit` answer from the plugin;
  `apps/server/src/game/crimes/` no longer exists, and neither does
  `apps/server/src/queue/index.ts` — crimes was its only consumer, so the
  cutover deleted the `queue/` module outright along with `startCrimeWorker`
  and the `crimeQueue` field on `AppDeps`.
- **First port with a BullMQ worker, and the first real exercise of the
  plugin job system.** `manifest.jobs`, seeded `ctx.job.rng`, and the
  `plugin_job_runs` idempotency guard had shipped with `examples/hello-plugin`
  and a unit test, but no game module had used them until this port. The
  route enqueues a `commit` job (`ctx.jobs.enqueue`); a worker resolves the
  roll, payout, exp, and possible jail sentence in one `ctx.transaction`, the
  same pattern every ctx capability already enforced for synchronous routes,
  now proven for the async case too.
- **`plugin_job_runs (plugin_id, job_id)` replaces `crime_log.job_id` as the
  idempotency guard.** `ctx.transaction` inserts into `plugin_job_runs` as its
  first statement; a retried job hits that primary key and throws
  `JobAlreadyAppliedError` before the handler body runs at all. `crime_log`
  still gets a row with `job_id` populated (existing tests assert on it), but
  the column and its unique index are now incidental — core still owns and
  migrates the table, the plugin only mirrors it.
- **Accepted deviation: a retried, already-committed job now emits zero
  events, where core republished `crime.resolved`** (design §2). Because
  `JobAlreadyAppliedError` aborts the transaction closure before any
  `publishCore` call executes, a replay cannot re-emit the event the way
  core's worker did on purpose (`game/crimes/worker.ts` "Decision 1"). The
  case this moves is narrow — a Postgres commit followed by a Redis publish
  failure — and under the plugin that event is lost until the client
  reconnects or re-fetches state, instead of being redelivered on the next
  retry. Accepted as the same class of deviation `bullets` took with its
  `no_location` 409: a rare, effectively-unreachable path whose core
  behaviour was an incidental property, not a designed guarantee.
  `crime-worker-idempotency.test.ts`'s `events.toHaveLength(2)` assertion is
  now `1`; the double-pay/double-jail/double-rank DB-state assertions in the
  same file are unaffected, since they're guarded by `plugin_job_runs`, not
  by events.
- **Loader change, applies to every plugin job, not just crimes' (design
  §2.5).** `createPluginQueues` now passes
  `defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay:
  500 }, removeOnComplete: 1000, removeOnFail: 5000 }` on every `new Queue(...)`
  call, matching core's old crime queue field for field. BullMQ's own default
  is `attempts: 1` — no plugin job retried before this fix, which also made
  the replay path above unreachable at runtime. This is shared loader code:
  every plugin job gains retries, on the reasoning that the at-least-once
  model (CLAUDE.md rule 1) assumes retries happen and `plugin_job_runs` makes
  a retry safe for any plugin job. No per-plugin opt-out exists; none was
  added — considered and rejected as SDK surface this one module doesn't
  justify. Revisit if `mail` or `gangs` need it.
- **A latent BullMQ queue-naming bug was found and fixed in the same commit
  as the loader change (`f537ecf`).** `pluginQueueName` joined
  `pluginId`/`jobName` with `:`, but BullMQ 5.81.3 rejects colons in queue
  names (`Queue name cannot contain :`). No plugin had declared `jobs` before
  crimes, so nothing was broken in practice — but crimes would have crashed
  at boot on the first real job declaration. Changed to `-`, and
  `bootTestServer`'s queue-prefix isolation likewise. The internal `Map` keys
  (`${pluginId}:${jobName}`) still use `:` and are unaffected — only the
  string passed to `new Queue`/`new Worker` mattered.
- **A job handler may open only one `ctx.transaction`.** Each call inserts a
  `plugin_job_runs` row first; a second call in the same job run hits that
  row and throws `JobAlreadyAppliedError` against its own prior call. Found
  while building the commit job, which was restructured to do all its reads
  and writes — the crime lookup that matters for correctness, the ledger
  credit, the exp/rank-up, the jail sentence, and the in-transaction
  `jailedUntil` re-read (below) — inside a single transaction. This is a real
  constraint on every future plugin job author, not specific to crimes.
- **A deliberate improvement over core, found in security review.** Core's
  worker read `player_crime_skill` filtered by `playerId` only and took
  `[0]` — an arbitrary row, since the table's primary key is composite
  `(player_id, crime_id)` and a player has one chance row per crime. A
  player who has attempted more than one crime could have their roll use
  another crime's chance. The plugin filters by `and(playerId, crimeId)`, so the
  committed crime's own chance is always the one used.
- **`effectiveJailedUntil` becomes an in-transaction read.** Core re-read
  `player_stats.jailedUntil` *after* commit so a replay's `crime.resolved`
  reported the real jail state rather than the (wrong, on a replay) local
  `jailed` flag. The plugin can't do a post-commit re-read — the event is
  buffered inside the transaction and flushed by the loader after commit — so
  the resolution is a single read inside the transaction, right after
  `sendToJail`: same connection (sees its own write), committed value on the
  fresh path, and never runs at all on the replay path (`JobAlreadyAppliedError`
  aborts first). Correct by construction, and one fewer round trip than
  core's post-commit re-read.
- **Two core responsibilities were absorbed by the ctx and deleted as code.**
  Core's worker re-read `player_stats.exp`/`.cash` after the transaction and
  called `recordScore` by hand for both leaderboards; the ctx economy
  wrappers already buffer one score per changed kind and flush after commit,
  so the ported job's `applyBalanceChange` + `applyExpAndRankUp` calls keep
  both leaderboards current with no extra code. Core's `alreadyProcessed`
  branch (catching a `crime_log_job_id_unique` violation to drive the
  replay-republish) is unreachable in the plugin path — `JobAlreadyAppliedError`
  aborts before any of that code could run — and was deleted rather than
  ported dead.
- **No lock-order test, deliberately.** Crimes touches only the acting
  player's own row — no location, no gang, no second player — so
  `applyBalanceChange`, `sendToJail`, and `applyExpAndRankUp` each lock that
  one row internally and there is no ABBA surface to regress. Recorded here
  (design §6) so a future reader doesn't add a `crimes-lock-order.test.ts`
  expecting parity with the bullets/travel ports; if crimes ever grows a
  second lock (an accomplice, say), that reasoning changes.
- **One deferred minor left open.** `packages/plugins/crimes/src/index.ts`
  imports `InsufficientFundsError` but never uses it — crimes only credits
  the player, it never checks or debits a balance. Dead import;
  `noUnusedLocals` is off in this repo's tsconfig, so it compiles clean.
  Harmless, but worth deleting the next time this file is touched.
- **A previously-open watch item is now closed.** `bank.test.ts`'s
  `app.inject` block used to boot `buildApp` with no `leaderboardPrefix`, so
  its ctx-buffered leaderboard writes landed in the shared global
  `leaderboard:*` keys every concurrent test file and agent uses. It now
  passes an isolated prefix, matching `bullets.test.ts`/`travel.test.ts`. See
  "Known issues and watch items" below — the bullet that used to record this
  is removed.

One module port remained: `gangs`. See below.

### The `mail` port (Plan 9)

`mail` ported to `packages/plugins/mail`; `apps/server/src/game/mail/` no longer
exists; `mail.test.ts`'s `app.inject` block is **unchanged** and is the proof
(all-HTTP, no service block, single-commit cutover).

Closest analog to `news`: event-driven write, no economy, no job, no jail gate,
no locks. No loader change — the first port since `ranks`/`notifications`/`news`
to add none.

`mail_messages` + `players` mirrors; `senderName` from `ctx.player.username`
(no `players` read for the sender); `recipientUsername` lookup via the
`players` mirror.

The two-check thread-participant gate preserved verbatim, including the
recipient-side splice guard (`routes.ts:50-51`) — the regression this
route's tests guard.

`.returning()` replaces core's post-insert re-select; the 400 carries no
`issues` array (plugin route layer property, same as `news`).

No lock-order test, deliberately — mail takes no `FOR UPDATE`, only implicit
`FOR KEY SHARE` on `players.id` via the FKs. No ABBA surface.

No `economy-invariant.test.ts` edit — mail moves no money.

### The gangs port (Plan 10)

Design: `docs/superpowers/specs/2026-08-11-plugin-gangs-port-design.md`. Three
commits: `d32068f` (SDK — `InsufficientGangFundsError` + `tx.gangs.hasPermission`),
`15fc85a` (the plugin package), and this cutover.

`gangs` ported to `packages/plugins/gangs` — all **15** routes (create, get,
list-mine, invite, accept/decline invite, leave, kick, grant/revoke
permission, deposit, withdraw, plus the remaining reads) answer from the
plugin; `apps/server/src/game/gangs/routes.ts` no longer exists.
`permissions.ts` and `logs.ts` in the same directory are deliberately left in
core — `apps/server/src/plugins/ctx.ts` imports `hasGangPermission`,
`GANG_PERMISSIONS` and `appendGangLog` from both, so only the route file
moved.

One `ctx.transaction` per route, preserving the pre-check/recheck lock
distinction core's routes made (an early permission check before acquiring
the lock, followed by the authoritative check after). No new lock-order
test — `gang-lock-order.test.ts` predates this port and is unchanged; it
already exercises `lockGangAndPlayerForUpdate`, which the ported routes call
through unmodified. No `economy-invariant.test.ts` edit either;
`gang-bank.test.ts`'s own 100-op deposit/withdraw sweep is the proof the
ported bank routes keep `sum(ledger) == balance`.

`tx.gangs.hasPermission` (Plan 10 Task 1, SDK) is the one new ctx capability
this port needed — three positional strings in, `Promise<boolean>` out,
narrowing the SDK's plain `string` to core's `GangPermission` union with a
type guard rather than a cast (CLAUDE.md: no casts in `packages/*`).

Cutover proof: registering `gangsPlugin` in `CORE_PLUGINS` before removing
`registerGangRoutes` from `app.ts` made `gangs.test.ts` fail at boot with
`FastifyError: Method 'GET' already declared for route '/api/gangs/:gangId'`
— proof the plugin was genuinely answering, not dead code. All 7
pre-existing gang **route** test files (`gangs`, `gang-bank`, `gang-members`,
`gang-lock-order`, `gang-invites`, `gang-membership`, `gang-transfer`, plus
`acceptance/m3-acceptance.test.ts`'s create→invite→accept→deposit→withdraw
flow) then passed unedited against the plugin — the wire-contract proof,
since every one of them drives the HTTP surface via `app.inject`.
`gang-ledger.test.ts` is the eighth gang test file but is not part of that
proof: it calls `applyGangBalanceChange`/`lockGangAndPlayerForUpdate` in
`economy/ledger.ts` directly, never `/api/gangs`, so it is unaffected by
(and says nothing about) the HTTP cutover; it also passed unedited, but
that was never in question since this port did not touch `economy/ledger.ts`.

**A structural behavioural difference, not a choice.** The gang bank
deposit/withdraw routes now write the player cash leaderboard, where core's
gang bank routes did not. `tx.economy.applyBalanceChange` buffers one
leaderboard score per changed kind and flushes it after commit
(`plugins/ctx.ts`); core's gang routes called `applyBalanceChange` directly
and never touched `recordScore`. Same shape as the `bullets`/`crimes` ports'
leaderboard pickup — inherent to routing through the SDK wrapper, not a
decision made for gangs specifically. Almost certainly an improvement; no
test covers it; no code was changed to produce or suppress it.

This closes M5's module-port track: nine of nine.

### PvP combat — the first gameplay that is not a port

Design: `docs/superpowers/specs/2026-08-11-pvp-combat-design.md`. Plan:
`docs/superpowers/plans/2026-08-11-pvp-combat.md`, 15 tasks, branch
`feat/pvp-combat`.

Nine ports preserved core's wire contract byte for byte, and every one of
them could be checked against a predecessor. This cluster has none. It is new
GL3-native gameplay written on GL2-derived columns (`items.effects`,
`player_stats.weapon_item_id` / `armor_item_id` / `hospital_until`), so the
schema is the only fixed constraint — the behaviour was decided here and the
tests are the whole specification.

**What shipped:**

- **`packages/plugins/combat`** — `POST /api/combat/attack/:targetId` (one
  shot per request; hit roll against accuracy, then damage minus armor) and
  `GET /api/combat/log`. All seven target-legality rules: not yourself, not
  hospitalised, not jailed, same location, not a gang-mate, both sides above
  the newbie exp threshold, enough bullets. A kill transfers the victim's
  **on-hand cash only** — the bank is safe, which is what makes depositing
  real counterplay — and sends them to hospital.
- **`packages/plugins/inventory`** — `GET /api/inventory`,
  `PUT /api/inventory/equip`, `POST /api/inventory/use`. Equip and heal live
  here, not in combat: they are inventory operations that combat happens to
  read the result of.
- **Core hospital** (`apps/server/src/game/hospital/`) — `GET /api/hospital`
  and `POST /api/hospital/discharge` (paid, ledgered as
  `hospital.discharge`), plus `settleHospital`, which clears an elapsed
  sentence on the player's next request.
- **Core `combat_log`** (`db/schema/social.ts`) with
  `combat_log_attacker_idx` and `combat_log_target_idx`, each on
  `(player, created_at)`, so the log route's attacker-or-target OR is
  index-covered in both directions.
- **SDK `accessInHospital`** (the route gate, alongside `accessInJail`) and
  **`tx.hospital.sendToHospital`**.
- **Settings are actually loaded.** `ctx.settings.get()` was dead surface
  until this work: `PluginCtxDeps.settings` was `{}` at every construction
  site, so every plugin that read a setting got `null` and silently took its
  default. `buildApp` and `bootTestServer` now load the `settings` table at
  boot (`257a91b`, `e9450b7`).

**Jail and hospital are core state facilities, not plugins.** A facility
gates *every* plugin's routes, and that gate has to live with the route
loader — a third-party plugin can hold a player through a ctx capability
(`tx.hospital.sendToHospital`) but cannot make other plugins' routes refuse
them. Combat is a plugin because it is gameplay; hospital is core because it
is a rule about all gameplay.

**`combat_log` has no `location_id`, deliberately** — this is the entry a
future reader is most likely to "fix". Adding one makes every log insert take
a `FOR KEY SHARE` on the `locations` row (CLAUDE.md rule 6: a foreign key is
a lock), inside a transaction that already holds two `player_stats` rows FOR
UPDATE. That is a player→location order, the exact inverse of the
locations-first order bullets and travel are held to, and it would reopen the
deadlock class those two were fixed for. The location a fight happened in is
recoverable from the participants; the lock order is not negotiable.

**Player↔player is now a live lock pair** — the third alongside gang↔player
and location↔player. Every combat path takes both rows through
`tx.locks.player([...])` → `lockPlayersForUpdate`, which dedupes, sorts
ascending and locks in one ordered statement, so A-shoots-B and B-shoots-A
cannot form an ABBA cycle. The three orders do not intersect: combat takes no
gang or location lock at all, only reads.

Two regression tests, both demonstrated red before being accepted:

- `test/combat-lock-order.test.ts` — A→B and B→A released together from a
  barrier that holds both rows in ascending order, so the interleaving is
  forced rather than hoped for. Under caller-order locking this produces a
  real `40P01` (captured in `/var/log/postgresql/postgresql-16-main.log`,
  surfacing as HTTP 500). The barrier deliberately locks in the *same* order
  the shipped helper does: an adversary locking B-then-A would deadlock the
  correct code too, and would prove the opposite of what it claims.
- `test/combat-concurrency.test.ts` — two killers, one victim on 1 hp holding
  300k. Exactly one 200 and one 409 `target_hospitalised`, one `combat_log`
  row, and `c1 + c2 == 300_000n`. Without the lock the second payout was
  stopped only by the ledger's overdraw guard, not by anything in the route.

`test/economy-invariant.test.ts` gained a **`kill`** op — 171 of 1000 ops in
the recorded run, all succeeding, 94 of them with a non-zero payout. It is
the first money movement in the game that is a transfer between two players
rather than between a player and the house, which is the case where a bug
could balance the attacker's ledger and leave the victim's short. Hospital's
paid discharge is **not** in that sweep and the file says so: it is a core
route, `callPluginRoute` cannot drive it, and `hospital.test.ts` already
asserts `sum(ledger) == balance` for it directly.

### Item economy — location shop, combat targets, and four web pages

Branch `feat/item-economy`, forked from `main`. Plan:
`docs/superpowers/plans/2026-08-12-item-economy.md`, 13 tasks.

This cluster extends the PvP combat cluster: the shop gives players a way to
obtain items (the gap the combat section recorded above), and the web pages
give every combat-related surface a browser UI.

**What shipped:**

- **Location shop** (`packages/plugins/inventory`) — `GET /api/shop` returns
  the stock for the player's current location; `POST /api/shop/buy` deducts
  cash via `applyBalanceChange`, decrements stock under the existing
  location→player lock order, and inserts an inventory row. No foreign keys
  on `p_inventory_shop_stock`, so no new lock edges. The buy handler
  exercises the economy invariant — `economy-invariant.test.ts` gained a
  `shopBuy` op.
- **`GET /api/combat/targets`** (`packages/plugins/combat`) — returns up to
  50 players at the attacker's location who pass the seven target-legality
  rules. Unpaginated, advisory: every rule is re-checked under the lock by
  `attack`.
- **Shared DTOs** (`packages/shared/src/dto/inventory.ts`,
  `packages/shared/src/dto/combat.ts`) — wire types for inventory items,
  shop stock, and combat targets, consumed by both the API routes and the
  web pages.
- **Four web pages** (`apps/web/src/pages/`):
  `/inventory` (equipped items, inventory list, equip/use actions),
  `/shop` (location stock with buy actions),
  `/combat` (target list from `GET /api/combat/targets`, attack form),
  `/hospital` (sentence timer, heal/discharge actions). Ordinary first-party
  React components in `apps/web/src/pages/`, routed in `App.tsx`, linked from
  the Shell nav.
- **`p_inventory_shop_stock`** table with migrations (`inventory:0001_shop_stock`,
  `inventory:0002_shop_stock_seed`). `inventory` is the first ported/gameplay
  plugin to own a table and migrations. The seed migration populates one row
  per (location, seeded item).
- **Three new test files:** `apps/server/test/shop.test.ts` (13 tests),
  `apps/server/test/shop-concurrency.test.ts` (1 test),
  `apps/web/test/effects.test.ts` (5 tests). The concurrency test
  was demonstrated red (stock going negative with the `stock >= quantity`
  predicate removed). `economy-invariant.test.ts` gained `shopBuy` coverage,
  demonstrated red when the buy handler bypassed `applyBalanceChange`.

**`effects.ts` duplication** between `combat` and `inventory` is unchanged
— this work did not make it worse and did not fix it. See the watch item
below.

### Bounties — kill contracts via cross-plugin filter

Design: `docs/superpowers/specs/2026-08-12-bounties-design.md`. Plan:
`docs/superpowers/plans/2026-08-12-bounties.md`, 8 tasks, branch
`feat/bounties`.

The first live consumer of the SDK filter system: the `combat` plugin exports
`killResolved` (a `filterPoint<{killerId, victimId}>`), and the `bounties`
plugin subscribes to it. When a kill lands, bounties sweeps all open contracts
on the victim to the killer in a single `UPDATE`. This is the same shape as
V2's `userKilled` hook — a plugin reacting to another plugin's event — but
implemented through the SDK's typed filter rather than a global hook.

**What shipped:**

- **`packages/plugins/bounties`** — `POST /api/bounties` (place a contract:
  escrow at placement, configurable minimum amount defaulting to 1000, no
  self-bounty, no bounty on a gang-mate) and `GET /api/bounties` (open list,
  newest first, limit 100). Uses the existing core `bounties` table
  (migration 0000) — no new table, no plugin migrations.
- **Claim sweep on kill** — subscribes to combat's `killResolved` filter
  point. On a fatal attack, sweeps all open bounties on the victim to the
  killer in one `UPDATE bounties SET claimed_by = $killer WHERE target =
  $victim AND claimed_by IS NULL`. A throwing subscriber is caught by combat;
  the kill response is unaffected.
- **`/bounties` web page** — place form (amount + target) and open list,
  first-party React in `apps/web/src/pages/`.
- **`packages/plugins/combat`** now exports `killResolved` via the SDK
  `filterPoint` API, applied post-commit on fatal attacks. This is the
  filter system's first real consumer.

**Crash safety:** the sweep is a single atomic `UPDATE ... WHERE claimed_by IS
NULL` — idempotent and claim-once by shape, no queue. If the process dies
between combat's commit and the filter run, the rows stay open and the next
kill of the same target sweeps them. Money is never lost, only delayed.

**Lock order:** placement locks `[placer, target]` ascending via
`tx.locks.player` before its FK-bearing INSERT; the claim sweep locks
`[killer]` only. An honest finding from development: the placement-vs-combat
ABBA the spec worried about is not actually reachable, because `tx.locks.player`
locks `player_stats` rows while the bounty INSERT's FKs take KEY SHARE on
`players` rows — they don't contend on the same rows beyond the placer's own
stats. The explicit lock call is still correct defense-in-depth; the regression
test (`test/bounties-lock-order.test.ts`) stays as a guard.

Four new test files: `test/bounties.test.ts` (place + list), `test/bounties-claim.test.ts`
(claim sweep on kill), `test/bounties-lock-order.test.ts` (concurrency guard),
`test/combat-kill-filter.test.ts` (the filter point itself).

### Detectives — cross-location hunting via time-gated reveal

Design: `docs/superpowers/specs/2026-08-12-detectives-design.md`. Plan:
`docs/superpowers/plans/2026-08-12-detectives.md`, 8 tasks, branch
`feat/detectives`.

The second real user of the plugin job system (after `crimes`). A player
hires detectives to locate a target who may be in a different city. The
search uses a seeded PRNG (deterministic and reproducible) in the
`resolve` worker — a deliberate deviation from V2's hire-time roll (spec
§0), identical in player experience because the outcome is hidden behind
a time-gated reveal until `ends_at`. No location is ever stored; a
successful report shows the target's **current** location via an un-cached
live JOIN on `player_stats.location_id`, only while the report is active
(`now < ends_at + expire`).

**What shipped:**

- **`packages/plugins/detectives`** — `POST /api/detectives` (debit via
  `applyBalanceChange`, insert search row with `succeeded = NULL` and
  `ends_at = now + duration × hours`, enqueue-after-commit `resolve`
  job), `GET /api/detectives` (list the hiring player's searches with
  time-gated reveal and live-location tracking), `DELETE
  /api/detectives/:searchId` (remove; ownership predicate inside the
  DELETE itself, so foreign and nonexistent rows answer identically — no
  existence leak). Uses core's existing `detective_searches` table
  (core migration 0000: `id, player_id, target_player_id, detectives,
  started_at, ends_at, succeeded bool nullable`). No plugin-owned table,
  no plugin migrations.
- **`resolve` job** — seeded `ctx.job.rng`, success iff `rng.int(0,100)
  < detectives × 4 × hours` (0..99 draw, so 5×4×5 = 100% always
  succeeds). The worker UPDATEs `succeeded`; a lost resolve (enqueue
  failure) leaves `succeeded = NULL`, which the list route reads as
  failed past `ends_at` — no row can hang pending forever. Idempotent via
  `plugin_job_runs (plugin_id, job_id)`. This is the second single-job
  plugin after `crimes`, so the `plugin_job_runs` PK gap (missing
  `job_name`) remains a watch item — see below.
- **Time-gated reveal** — the list route hides `succeeded` until `now ≥
  ends_at`; a NULL `succeeded` past `ends_at` reads as failed. A successful
  report shows the target's current location via an un-cached LEFT JOIN on
  `player_stats.location_id` → `locations`, gated on `now < ends_at +
  expire`. No location column exists — live tracking is just the join.
- **Settings:** `detectives.cost` (price per detective per hour-unit;
  total = cost x detectives x hours, default 125000),
  `detectives.duration` (seconds per hour-unit; ends_at = now + duration x
  hours, default 3600), `detectives.expire` (seconds after ends_at that a
  successful report keeps showing the target's live location, default 600).
  Bare keys plugin-side — the spec's V2 names adapted to the `ctx` prefix.
- **No lock-order test, deliberately.** Detectives touches only the hiring
  player's own row — no location lock, no gang lock, no second-player lock.
  `applyBalanceChange` locks that one row internally; the detective INSERT's
  FK on `players` takes `FOR KEY SHARE` on the target, but the target row is
  never locked FOR UPDATE, so there is no ABBA surface.
- **No combat coupling.** Unlike bounties, detectives does not subscribe to
  `killResolved` or any other filter point. It is self-contained.
- **No WS events.** The list page polls; no live push on hire or reveal.
- **No target notification.** The target is never informed that a detective
  was hired on them — spec requirement.

**Deliberate absences:** no lock-order test (single-player lock only), no
combat coupling (no filter-point subscription), no WS events (polling only),
no target notification (silent by design).

Two new test files: `test/detectives.test.ts` (hire + list + reveal +
remove), `test/detectives-worker.test.ts` (worker determinism, idempotency,
4%/100% boundary cases). `economy-invariant.test.ts` gained a `detectiveHire`
op. The web page is at `/detectives` (`apps/web/src/pages/`).

### Organized crime — four-role heists with buy-in escrow and shared fate

Design: `docs/superpowers/specs/2026-08-12-organized-crime-design.md`. Plan:
`docs/superpowers/plans/2026-08-12-organized-crime.md`, 10 tasks, branch
`feat/organized-crime`. The second GL3-native gameplay cluster that owns its
own tables with migrations (after `inventory`), and the third single-job
plugin (after `crimes`, `detectives`).

A leader (mastermind) creates a heist at their location with a buy-in, invites
three more players to fixed crew roles (driver, gunman, hacker), and when the
crew is full and co-located fires execution — a seeded BullMQ `resolve` job
rolls **one** outcome for the whole crew: success splits the pot (buy-in × 4 ×
multiplier) equally four ways, failure jails everyone and forfeits the
buy-ins. Same shared fate either way.

**What shipped:**

- **`packages/plugins/oc`** — eight routes under `/api/oc`: `POST /` (create,
  escrows the leader's buy-in), `GET /` (the viewer's active heist + pending
  invites), `POST /:id/invite` + `/decline`, `/accept` (escrows buy-in, flips
  the partial-unique-index-armed member row to `accepted`), `/leave` (refund),
  `/cancel` (refund all, leader-only), `/execute` (202, enqueues `resolve`).
  Two plugin-owned tables (`p_oc_heists`, `p_oc_members`), three migrations
  (tables + the one-active-heist partial unique index). **No foreign keys** —
  an FK is a lock, and OC must add no implicit `FOR KEY SHARE` edges against
  core rows (the same decision `p_inventory_shop_stock` records).
- **One-active-heist-per-player** is a partial unique index
  (`p_oc_members_active_player ON p_oc_members (player_id) WHERE NOT released
  AND state = 'accepted'`), not a check-then-act. It binds only on ACCEPTED,
  unreleased rows, so multiple pending invites are fine. The create/accept
  routes catch 23505 on this constraint name (`isActiveHeistConflict` walks
  `err.cause` recursively — more robust than gangs' code-only check).
- **`resolve` job** — exactly one `ctx.transaction` (a second self-collides
  on `plugin_job_runs`, the crimes-port finding; the failure is silent
  success). Seeded `ctx.job.rng.int(0, 10_000)` roll against
  `oc.success_chance`; success pays `share = buyIn × 4 × multiplier / 4` per
  member (a remainder-to-leader line is kept though provably 0 for integer
  multipliers — bigint division truncates and a future fractional setting
  would silently burn money without it); failure `tx.jail.sendToJail`s all
  four. Rows released, heist marked done/failed, `oc.resolved` published per
  member. Post-commit best-effort `SET NX EX` cooldown per member (rule 2 —
  atomic; a crash there loses at most some cooldowns, never money).
- **Lock order — a new root that shares no edge with the existing three.**
  Every transaction that reads heist/slot state to decide takes the heist row
  `FOR UPDATE` **first** (`lockHeist`), then `tx.locks.player([...])`
  ascending. Because the OC tables carry no FKs, no OC insert takes an
  implicit lock on a core row — so the heist→player order's only shared
  surface with combat/gang/travel is the players suffix, which is always
  ascending via the same helper, and no cycle can form. `POST /api/oc` is the
  one exemption (it INSERTs its own heist row under a fresh uuidv7, the
  `POST /api/gangs` argument). Regression tests at
  `test/oc-concurrency.test.ts` (slot race, execute-vs-leave) and
  `test/oc-lock-order.test.ts` (heist-first barrier), both demonstrated red
  first (CLAUDE.md rule 6 corollary).
- **`oc.updated` / `oc.resolved`** are two new core `GameEvent` variants
  (21 total now). `oc.updated` is a state-refresh signal — no toast, just an
  invalidation of the `/oc` query; `oc.resolved` carries the outcome copy.
  `tx.events.publishCore` publishes them; the audience is `player` per member
  (AudienceSchema has no multi-player kind).
- **Settings:** `oc.buy_in_min` (1000), `oc.success_chance` (0.35),
  `oc.payout_multiplier` (3), `oc.jail_seconds` (600),
  `oc.cooldown_seconds` (1800). Read once at boot via `ctx.settings`; the
  ctx prefixes `oc.`.
- **`/oc` web page** (`apps/web/src/pages/OrganizedCrime.tsx`) — slot grid
  for the four roles, invite cards, create/invite/accept/decline/leave/
  cancel/execute mutations, leader-only invite forms, execute enabled only
  at 4/4. Driven by the `["oc"]` query; `oc.updated`/`oc.resolved` invalidate
  `["oc"]` + `["me"]`.
- **`sum(ledger) == balance`** is proven for all four members across all three
  outcomes (success, failure, cancel) in a dedicated `test/oc-ledger.test.ts`
  (the async job needs its own file; `economy-invariant.test.ts`'s
  synchronous sweep cannot drive it — the `hospital.test.ts` precedent).

**Watch items:**

- **Overlapping invites for one seat are by design** — two players may hold
  invites for the same role; first to accept wins (the accept route checks
  the role against ACCEPTED rows only, under the heist lock). A declined or
  beaten loser's invite row lingers until they decline or accept elsewhere.
- **The cooldown `peek` gate on create/accept is advisory** (documented in
  code) — the worst race lets a player in a second early; it cannot lock
  anyone out. The `SET` happens post-commit in the worker; a crash there
  loses cooldowns, never money.
- **`GET /api/oc` returns no resolved-heist history** — the outcome surface
  is the `oc.resolved` event only. Once a heist resolves, the viewer's
  `heist` goes null and the create form returns.
- **The `plugin_job_runs` PK gap (missing `job_name`) does not bite here.**
  OC declares exactly one job (`resolve`), so the `(plugin_id, job_id)` key
  collision between two queues of one plugin is not reachable — same
  reasoning as `crimes` and `detectives`. Do not declare a second OC job.
- **The execute-while-`executing` re-fire is the crash-recovery path.** A
  commit-then-crash between the execute transaction and the enqueue would
  otherwise strand a heist at `executing` forever. Re-firing execute on a
  status of `open` OR `executing` lets the second attempt re-enqueue; the
  worker serializes on the heist `FOR UPDATE` and no-ops if the first already
  resolved.

Five new test files: `test/oc.test.ts` (all eight routes' contracts),
`test/oc-worker.test.ts` (resolve job: success split, failure jails, retry
idempotency, stale no-op, cooldown TTL), `test/oc-concurrency.test.ts` (slot
race, execute-vs-leave), `test/oc-lock-order.test.ts` (heist-first barrier),
`test/oc-ledger.test.ts` (sum(ledger)==balance across outcomes). Two
`invalidation.test.ts` cases + a shared `dto/oc.ts`.

### Table ownership correction — three tables moved out of core

Core migration `0007_relinquish_plugin_tables` drops `bounties`,
`detective_searches` and `combat_log`. The first two shipped in
`0000_core_schema` and the third in `0005_combat_log`, all three for the same
non-reason: the core schema was written before the plugin migration runner
existed. No core code ever read or wrote any of them — `grep` across
`apps/server/src` found each named only in `db/schema/social.ts`, which
declared it, and nowhere else. Each has exactly one consumer, and that
consumer now owns and creates it:

| was | now | owner |
|---|---|---|
| `bounties` | `p_bounties_bounties` | `packages/plugins/bounties` |
| `detective_searches` | `p_detectives_searches` | `packages/plugins/detectives` |
| `combat_log` | `p_combat_log` | `packages/plugins/combat` |

Five of the fourteen plugins now declare migrations, up from two. Nothing about
the mechanism changed: `runPluginMigrations` (`apps/server/src/plugins/migrate.ts`)
already iterated every manifest at every boot and `migrations` already defaulted
to `[]`, so plugin-owned tables have always been created at install. Only the
declarations moved.

**Decisions worth not relitigating:**

- **DROP, not RENAME.** GL3 has no live installs, and preserving rows would
  have forced the plugin migrations into `CREATE TABLE IF NOT EXISTS` —
  weaker than the plain `CREATE` that `p_inventory_shop_stock` and `p_oc_*`
  use, and weaker than the 42P07 `plugin-migrate.test.ts` relies on to prove a
  migration ran exactly once. A deployment that *does* hold rows must dump the
  three tables before applying 0007 and reload them after boot; the column sets
  are identical, only the names changed. Stated in the migration's header too.
- **The foreign keys moved with the tables.** `p_inventory_shop_stock` and
  `p_oc_*` deliberately carry none (CLAUDE.md rule 6 — an FK is a lock edge),
  but that was a choice available to *new* tables. These are existing tables
  changing hands: dropping their FKs would both leave orphan rows behind a
  deleted player, with nothing to clean them up, and alter a lock graph that
  `combat-lock-order.test.ts` and `bounties-lock-order.test.ts` already pin.
  Keeping them makes the move a pure change of ownership.
  `combat-log-schema.test.ts` now asserts all three of `p_combat_log`'s FKs and
  their `ON DELETE` rules, so that stays a defended decision rather than an
  accident of the DDL.
- **`p_combat_log` still has no `location_id`,** for the reason `social.ts`
  recorded before the move: its FKs are taken while the transaction holds two
  `player_stats` rows `FOR UPDATE`, so a `locations` FK would take `FOR KEY
  SHARE` on a location row there — player-then-location, closing an ABBA cycle
  against the location-first order `travel` and `bullets` follow. The reasoning
  moved to `packages/plugins/combat/src/migrations.ts` with the DDL.

**The drizzle snapshot chain was already broken and is now repaired.**
Migrations `0005` and `0006` were hand-written with no `meta/*_snapshot.json`,
so `drizzle-kit generate` diffed against the `0004` snapshot: its first output
for this change omitted the `combat_log` drop entirely and invented a
`DROP INDEX "crime_log_job_id_unique"` that `0006` had already done (and which
would have failed the migration — `0006` used `IF EXISTS`, the generated line
did not). `0007_relinquish_plugin_tables.sql` is therefore hand-written, but
the generated `meta/0007_snapshot.json` is kept: it is the first snapshot in
three migrations that matches reality, so the next `generate` starts clean.

**The trap this sharpened, for whoever adds the next plugin table.** The test
template database is built from core migrations only
(`test/helpers/global-setup.ts:47`), so a test file that drives a plugin
*without* `bootTestServer()` — `callPluginRoute` or `runPluginJob` directly —
sees no plugin tables at all and dies on 42P01. Three files needed an explicit
`runPluginMigrations`: `detectives-worker.test.ts` and `economy-invariant.test.ts`
(which already did it for `inventory`, and now names `combat` and `detectives`
too), plus `combat-log-schema.test.ts`, which was previously a pure
`information_schema` read against a core table. That last one gained a
"creates the table at all" case first, because every other assertion in the
file passes vacuously when the table is absent — `toMatchObject` on `{}` and
`toHaveLength(0)` on a missing column are both green. Demonstrated failing:
with `migrations: []` on the combat manifest, 4 of its 5 cases fail and the
"no location_id" case is the one that still passes.

Test-side handles for the three tables live in
`apps/server/test/helpers/plugin-tables.ts` — the `oc-*.test.ts` per-file
`pgTable` mirror pattern with the copies collapsed into one file, since the
plugin packages export only their manifest.

Suite went 966 → 968: `combat-log-schema.test.ts` gained the existence guard
and the foreign-key assertion. `schema.test.ts`'s three census figures moved
with the tables — 47 → 39 foreign keys (24 cascade, 15 set null) and 30 → 27
non-primary-key indexes.

## What M3 established that later work must not undo

- **Lock ordering is per row-pair, not one global rule for the whole app.** There
  are two orders and they do not conflict: gang↔player goes through
  `lockGangAndPlayerForUpdate` (UUID comparison); location↔player is **always
  locations first** — a single location via `lockLocationForUpdate` (bullets), or
  several via `lockLocationsForUpdate` which sorts them ascending (travel locks
  both its source and destination rows through it). Adding a path that locks a
  location and a player in a new order, or a gang and a player outside the helper,
  reintroduces SPEC §2.3's deadlock class.
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

## M4 — the migration CLI (complete)

`apps/migrate` converts a live V2 **MySQL** database into GL3 Postgres. All 33 plan
tasks shipped on `feat/m4-migration-cli`; `apps/migrate/README.md` is the operator
documentation. Shape:

- **18 migrators** composed by `orchestrator.ts` into the 8-phase pipeline SPEC §4.2
  orders (roles → rounds → content → players → gangs → inventory/properties → social
  → settings), one Postgres transaction per phase via `runPhase`.
- **Idempotency is a table, not a convention.** `id_map(v2_table, v2_id) -> v3_id`
  resolves every V2 auto-increment id to a stable UUIDv7, so a re-run updates in place.
  `orchestrator-idempotency.test.ts` runs the whole pipeline three times and asserts
  identical counts across all 26 target tables — SPEC §6's first criterion.
- **The V2 login criterion is proven against the real server**, not a stub:
  `legacy-login.test.ts` is the only migrate test that boots Fastify (`bootTestServer`)
  against a just-migrated database, logs a V2 player in with their plaintext V2
  password, and asserts the lazy argon2id upgrade — and that re-running the migrator
  afterwards does not revert it. SPEC §6's second criterion.
- **The ledger cannot start empty.** V2 keeps only current balances, but CLAUDE.md
  rule 3 requires `sum(ledger) == balance`, so the players migrator writes one
  `migration.opening_balance` row per non-zero balance kind — directly, *not* through
  `applyBalanceChange`, which would double-count. Deterministic `job_id` makes those
  inserts idempotent through the same UNIQUE that guards the crime worker.
- **Orphans are data, not errors.** V2 has no foreign keys; rows referencing deleted
  users/gangs/items are skipped and counted in the report, never fatal.
- **The bin is bundled, not just compiled.** `dist/cli.js` is an esbuild bundle
  because `apps/migrate` imports the server's schema and db client across a project
  boundary and `tsc` emits those relative specifiers verbatim — the plain `tsc` output
  died at load with `ERR_MODULE_NOT_FOUND`, invisible to a suite that only ever calls
  `main()` through vitest's resolver.

Two environment notes that outlive the milestone: MariaDB 10.11.14 is installed
natively as the wire-compatible MySQL substitute and hosts only throwaway test
fixtures (`MYSQL_ADMIN_URL`, see `.env.example`), and `apps/migrate/vitest.config.ts`
exists because the project was a bare directory entry inheriting vitest's default
5s `testTimeout` while every other Postgres-touching project got 30s — under full
load that timed out 30 tests with no assertion failure anywhere.

**GL3 remains Postgres-only.** `apps/server`, `apps/web` and `packages/shared` have
zero MySQL dependencies. `mysql2` appears only in `apps/migrate`. The data flow is
one-way — V2 MySQL → GL3 Postgres — and the migrator is a one-shot cutover tool.

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
- **Create-gang's duck-typed unique-violation check tests only `code === "23505"`,
  not `constraint_name`.** `gangs_name_unique` is the sole unique constraint
  reachable on that insert path today, so any `23505` there is unambiguous —
  but the check would misattribute a different constraint's violation to
  "name taken" if a second one is ever added to `gangs`. Narrow the check
  (match `constraint_name` too) if that happens.
- **`GANG_PERMISSIONS` now exists in three places**: `packages/shared/src/dto/gangs.ts`,
  core's `apps/server/src/game/gangs/permissions.ts`, and
  `packages/plugins/gangs/src/index.ts`. The enum-sync test
  (`gang-members.test.ts:52`) guards shared↔core only; shared↔plugin drift
  would surface at runtime as a `z.enum` mismatch on the PUT/DELETE
  permission param, not at compile time or in that test.
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
- **`@gl3/plugin-news` is imported by `core-plugins.ts` but absent from
  `apps/server/package.json`** (all four other core plugins are listed). It
  resolves only via npm workspaces hoisting today. Pre-existing, outside this
  branch's scope; recorded here so it is not lost. Adding it to `package.json`
  is the fix when the next port touches that area.
- **`travel_cooldown_seconds = 0` makes `acquireCooldown` call Redis
  `SET ... EX 0`**, which Redis rejects, surfacing as an HTTP 500 on any
  travel. Pre-existing, carried verbatim from core, outside this port's
  remit. A live game sets a positive value; the path is unreachable in any
  sensible config but is a real crash on the misconfigured one.
- **A second `ctx.transaction` in one job handler fails silently as success.**
  `runPluginJob` swallows `JobAlreadyAppliedError` (`apps/server/src/plugins/jobs.ts`),
  which is correct for a real BullMQ retry. But a handler that opens a second
  `ctx.transaction` commits its first, throws on the second's duplicate
  `plugin_job_runs` claim, is reported complete to BullMQ, and silently skips
  everything after — no error, no retry, no log. A boolean latch on the ctx
  throwing a distinct, non-swallowed error would close it. The `crimes` port
  hit this during development; every job handler shipped so far uses exactly
  one `ctx.transaction`, so it is latent, not live. Neither `mail` nor
  `gangs` declares a job, so both closed without exercising this — still
  open for whichever future plugin needs a second.
- **`plugin_job_runs`'s PK omits the job name.** `apps/server/src/db/schema/plugins.ts`
  keys on `(plugin_id, job_id)`, but BullMQ ids are per-QUEUE counters starting
  at 1. A plugin declaring two jobs would have both queues issue id `"1"`, and
  the second would be silently swallowed as already-applied. Latent for
  `crimes` (one job); neither `mail` nor `gangs` declares any job, so nine of
  nine module ports have now shipped without triggering it — still open for
  the first plugin that declares two.
- **`detective_searches.player_id` has no index** for the list route's
  `WHERE player_id = ?` (bounties got `bounties_target_idx` for its
  equivalent). Table is core-owned (migration 0000), so the fix is a core
  migration — out of scope for this plugin branch.
- **`GET /api/combat/log` is bounded at 50 but not paginated.** Bounded from
  the first commit, deliberately — unlike mail and notifications above — but
  there is no way to page further back, so a player's older fights are simply
  unreachable over the API.
- **Settings are read once, at boot.** `buildApp` loads the `settings` table
  into `PluginCtxDeps.settings` and nothing refreshes it, so changing a
  `combat.*` or `hospital.*` row needs a server restart to take effect. Fine
  for admin-edited config; surprising to anyone expecting live tuning.
- **`effects.ts` is duplicated** between `packages/plugins/combat` and
  `packages/plugins/inventory` (weapon/armor/consumable effect schemas and the
  item-type constants). A plugin may not import another plugin, so the two
  copies are kept in step **by hand and nothing enforces it** — a drift shows
  up as combat reading an item inventory wrote differently. The natural fix is
  the equipment/inventory split the design defers to the item-economy cluster.
- **`player_stats.backfire` is still unused.** The V2-derived column exists
  (integer, default 0) and nothing in combat reads or writes it. The backfire
  mechanic is not implemented.
- **No kills leaderboard.** `combat_log` has everything needed to build one;
  nothing does. Deferred with the rest of the leaderboard work.
- **The item economy is half-open.** A per-location shop inside the
  `inventory` plugin (`GET /api/shop`, `POST /api/shop/buy`) now sells
  weapons, armor, and consumables from `p_inventory_shop_stock`. Buy-only;
  no player-to-player trading, no sell-back, no restocking, and no item drops
  from crimes or kills yet. The seeded starter rows and admin inserts remain
  the only other source. The `p_inventory_shop_stock` table carries no
  foreign keys, so it adds no lock edges (design §4.1).
- **`inventory` now owns a table and migrations.** It was the first ported or
  gameplay plugin to do so — `p_inventory_shop_stock` (migration
  `inventory:0001_shop_stock`) plus a seed migration (`inventory:0002_shop_stock_seed`)
  that populates one row per (location, seeded item). The table has no
  foreign keys by design; see above. `oc` followed, and the table-ownership
  correction below has since brought `bounties`, `detectives` and `combat`
  into the same shape.
- **`inventory` and `combat` now have web pages** (`/inventory`, `/shop`,
  `/combat`), and core hospital has one too (`/hospital`). Ordinary
  first-party React pages in `apps/web/src/pages/`, routed in `App.tsx`.
- **`GET /api/combat/targets`** exists, bounded at 50, unpaginated, and
  advisory — every target-legality rule is re-checked under the lock by
  `POST /api/combat/attack/:targetId`.
- **Queue-prefix isolation stops at Redis.** Two `loadPlugins`/`bootTestServer`
  boots in one test file get separate prefixed queues (ids restart at 1) but
  share one database, so the second boot's first job would be swallowed as
  already-applied by the first boot's `plugin_job_runs` row. No file does both
  today.

**Resolved, but the reasoning matters if you touch these areas:**

- **`bank.test.ts`'s `app.inject` block used to boot `buildApp` with no
  `leaderboardPrefix`** (`apps/server/test/bank.test.ts:114`), so its
  ctx-buffered leaderboard writes landed in the production global
  `leaderboard:*` keys that every concurrent test file and agent shares.
  Nothing read those keys in tests, so it was dirty rather than broken, but
  `bullets.test.ts`/`travel.test.ts` already passed an isolated prefix on the
  equivalent call. Closed during the `crimes` port (Plan 8) — `bank.test.ts`
  now passes an isolated prefix too.

- **The location↔player lock-order defect (the old bullets watch item, both
  halves).** The bullets purchase used to read `player_stats.location_id`
  unlocked before taking the location lock — a `travel` committing in that
  window let a player buy at a location they had already left (the staleness
  half). The same unlocked read was also what made the deadlock half
  reachable: `performTravel` took `player_stats` FOR UPDATE first and reached
  `locations` implicitly through the `FOR KEY SHARE` Postgres takes on the
  `location_id` FK — the opposite order from bullets, closing an ABBA cycle
  (`40P01`, same shape as the M3 gang deadlock) across the two location rows
  a player visits in sequence. Both halves are closed. `@gl3/plugin-travel`
  now locks both its location rows (source **and** destination) through
  `lockLocationsForUpdate` before the player row, matching bullets' order.
  Locking only the destination — the constraint this section originally
  recorded — would have closed the deadlock but left the staleness half open:
  a travel OUT of location L never touches `locations[L]`, so a buy reading
  L could still race it. Both rows are locked for that reason. Regression
  test: `apps/server/test/travel-lock-order.test.ts` — a raw-SQL adversary
  against the real travel handler, forced via observed `pg_stat_activity`
  wait state, shown red (a real `40P01` in the server log) under the
  inverted order.

  A direct real-buy-vs-real-travel regression test cannot be built, and the
  reason is worth recording so nobody re-attempts it: the cycle needs a buy
  to hold `locations[L]` while the player sits somewhere else, so a travel's
  destination can be L. But the real handler derives L from
  `player_stats.location_id` and locks it in the same uninterrupted stretch
  of code; making that read stale means moving the player between the read
  and the lock, a window internal to the handler with no hook. Every
  blocker placement collapses — on `player_stats` the player cannot move, on
  `locations[L]` the intervening travel needed to move them deadlocks the
  setup against the fixed code, and doing that travel first makes the buy
  read C instead of L. A test-only pause inside the shipped bullets
  transaction was rejected — it would put scaffolding inside a verified
  port to expose the very window this port removes. The hand-written
  adversary in `travel-lock-order.test.ts` is the substitute, and its
  construction is documented at the top of that file.
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
