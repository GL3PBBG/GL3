# GL3 project status

Last updated: 2026-08-17, **properties as franchises complete** — `plugin_id`
goes live, income becomes consumer-paid (`bullets` the first consumer), and a
live M4 defect (`PR_owner` → `PR_user`) is fixed, shipped after **rounds**, a
seasonal scoring window, core rather than a plugin, which itself shipped
after the four migrated-but-unread-table clusters (properties' income-accrual
model was the last of those, now superseded by this cluster).
Branch: `feat/properties-franchise`. Final verification for this branch was
**scoped**, not a green full run — see the properties-franchise section below
before assuming the whole tree is proven.

---

## Milestones

| Milestone | State | Notes |
|---|---|---|
| **M0 Scaffold** | ✅ complete | Monorepo, CI, docker-compose, all 32 tables migrated |
| **M1 Auth + vertical slice** | ✅ complete | Acceptance criterion proven end to end |
| **M2 Core loop parity** | ✅ complete | `sum(ledger) == balance` gate passing |
| **M3 Social** | ✅ complete | Both SPEC §6 checkmarks proven end to end |
| **M4 Migration CLI** | ✅ complete | `apps/migrate` — 18 migrators, 8-phase pipeline, idempotent via `id_map`; both SPEC §6 criteria proven (below) |
| **M5 Plugin SDK** | 🚧 in progress | Foundation + web renderer shipped. The event-envelope blocker is resolved (`tx.events.publishCore`); nine of nine module ports shipped (`ranks`, `notifications`, `news`, `bank`, `bullets`, `travel`, `crimes`, `mail`, `gangs`) — the module-port track is complete. `profile`/`leaderboard`/`jail` are deliberate non-ports. **PvP combat** (`combat` + `inventory` plugins, core hospital), **item economy** (location shop, combat targets, four web pages), **bounties** (kill contracts, first live cross-plugin filter — `killResolved`), **detectives** (cross-location hunting, time-gated reveal, live-location tracking), **organized crime** (four-role heists, buy-in escrow, shared-fate seeded job), **admin + ABAC-lite authz** (role-module grants, first-user admin, loader admin tier, six plugin admin sections + core role management), the **sentence sweeper** (server-side jail/hospital release tick replacing 2s client polling), **money ranks + backfire + weapon condition** (first of four clusters activating migrated-but-unread V2 tables), and **car theft + garage + police chase** (the `theft` plugin, second cluster), and **properties** (location income, lazy accrual, the `properties` plugin, third cluster) have since shipped. **Rounds** (seasonal scoring window, lazy rollover under an advisory lock, points payout, core rather than a plugin) has since shipped on top of that. **Properties as franchises** (`plugin_id` live, `(location_id, plugin_id)` key, consumer-paid income replacing the accrual clock, `bullets` as first consumer, seizure-on-death disowns rather than transfers) has since shipped on top of that — see the sections below |

**Suite: 181 files / 1380 tests** as of `feat/properties-franchise` — up from
177/1370 on `main` (net +4 files / +10 tests: properties-as-franchises added 6
test files / 30 tests and removed 2 / 17 with the accrual model, plus small
net changes inside existing files — see that section for the itemised
breakdown). **This total is backed by a green full run**: a bare
`npm run verify` on HEAD `e7ea8af` exited 0 with `Test Files 181 passed (181)`
and `Tests 1380 passed (1380)`, no unhandled rejections and no void files (the
two `(0 test)` entries are `@gl3/plugin-sdk`'s `.test-d.ts` typecheck-only
files). That run supersedes the earlier exit-1 run and the scoped
reconfirmations that followed it; see the properties-franchise section for
that history. (M4 added the 30 files / 58 tests of the `@gl3/migrate` project; the
pre-M4 tree ran 111 / 968. Money ranks, backfire and weapon condition added 5
files / 70 tests; car theft added 8 files / 60 tests; properties added 7
files / 55 tests (52 at first ship, plus 3 from the final-review fix pass:
N1's admin-create-default-rate test and N13's two income-cap tests); rounds
added 10 files / 92 tests plus 9 more inside existing files. This file has
recorded a measured-vs-summed drift before (1272 vs. a 1271 sum at the
properties milestone); 177/1370 was the number `npm run verify`'s own summary
line reported on a clean run at commit `9b47d61`, the `main` commit this
branch started from, not a sum reconstructed from per-cluster deltas.)

The **item admin pass** on top of that added one file and 26 tests. It closes
three flaws in the inventory admin, all downstream of `ItemBodySchema` being
narrower than `WeaponEffectsSchema`: only three of a weapon's eight stats were
settable, the items table printed the raw `effects` jsonb, and items were
create-only — a seeded item such as Rusty Pistol could never be edited.
`admin-inventory` +16 (every weapon stat on create, blank-means-absent, the
per-stat columns, and the new `POST /api/admin/inventory/items/update`, which
refuses a type-mismatched body rather than let an admin write `{armor}` onto a
weapon and brick it), `plugins-render` +2, SDK `view-schema-contract` +4, and
the new `admin-hidden-discriminator` (2, a unit-project walk asserting all six
item forms carry `itemType` as a hidden constant).

Two form field types were added to the view vocabulary for it, each in all
three copies (SDK, DTO, the renderer's hand-written one): **`decimal`**, a
`number` input with `step="any"`, because a weapon's `critMultiplier` is the
vocabulary's only float and `<input type="number">` defaults to `step="1"` —
the browser rejects 1.5 before it is ever submitted; and **`hidden`**, a
strict branch carrying a `value` and no `label`, which draws nothing and
submits its constant. `hidden` is what removes the six free-text `itemType`
boxes an admin previously had to type a discriminator into, where one typo was
a 400.

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

The **sentence sweeper** has since shipped: a tick
(`apps/server/src/game/sweep/sweeper.ts`, `SWEEP_INTERVAL_MS`, default 2000,
`0` disables) that ends elapsed jail and hospital sentences without waiting
for the player to ask, publishing `player.released` and the new
`player.discharged`. The lazy path on the gated routes is unchanged and
still authoritative when no sweeper runs. Its claim is the existing
`WHERE ... IS NOT NULL` UPDATE, so a second instance is safe with no
bookkeeping table; it settles one player per transaction holding one lock,
which is why it shares no edge with the four existing lock pairs
(`test/sentence-sweeper-lock-order.test.ts`). The web client's 2-second jail
and hospital polls dropped to a 30-second socket-down backstop, and the
hospital poll — previously unconditional — now runs only while the player is
actually admitted.

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
sentence. A shot can also **backfire**: the bullets are spent, the shooter
takes the damage themselves and may be hospitalised by it, the target is never
touched and never told. Chance comes from the weapon's own `backfireChance`
scaled by how worn it is — weapons degrade with every shot and with elapsed
time, and are repaired at the gunsmith route in `combat`. A player's lifetime
backfire count and their wealth bracket both show on the public profile; the
cash figure behind the bracket does not.

Every balance movement anywhere is an append-only ledger row inside the same
transaction as the balance update.

They can buy property. Each location has one property; buying it sets the
owner and starts the income clock, claiming banks whole hours × rate (capped),
and selling returns the purchase price plus banked income. Income accrues
lazily — nothing is stored until claimed, and a zero-claim is free. The page
shows every property in the world: buy when unowned, claim (with live
accrued) when yours, nothing when another's.

They can steal cars. A theft attempt draws a weighted pick from the chosen
tier's value bracket; success parks the car (with rolled damage) in the city
they are standing in, failure runs a police chase — get away clean, or serve
`chase.jail_seconds`. The garage lists, sells (value scaled by damage,
truncating toward the house) and repairs (cost per damage point) — all only
from the city the car sits in, which is where it stays.

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
= core-only boot, unchanged). Boot is a static import map — a dynamic
`import(pluginId)` is deliberately not used so the dependency-direction check
stays compiler-enforceable. That map is now **generated** (see below), not
hand-written.

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

### Money ranks, backfire and weapon condition

Spec: `docs/superpowers/specs/2026-08-15-money-ranks-backfire-weapon-condition-design.md`.
The first of four clusters bringing migrated-but-unread V2 tables into play.
Three features that share one surface (the shot resolution in `combat`) and one
rule (a bracket is public, the figure behind it is not).

**Money ranks.** `money_ranks` (label, threshold) was migrated and never read.
The bracket is now computed as the highest row whose `threshold <=
cash + bank` and served two ways: `moneyRankLabel` on the **public** profile
DTO, and the whole ladder on `GET /api/ranks` beside the exp ranks, rendered
as a second table on `/ranks`. Below the lowest threshold, and on an empty
table, the label is `null` rather than an error.

The load-bearing property is the one `money-ranks.test.ts` pins last: the
profile route SELECTs `cash` and `bank` to compute the label and must never
return either. "The bracket is public, the figure is private" is the rule; the
test asserts the response has no `cash` or `bank` property and that the digits
of the figure appear nowhere in the serialised body. Widening that payload
later is how the rule gets broken by accident.

**Backfire.** `player_stats.backfire` is a lifetime counter, incremented once
per backfired shot. A backfire consumes the bullets, deals `selfDamage` to the
shooter, can hospitalise them, and never touches the target. The new
`player.backfired` core event carries `selfDamage` and `hospitalised` and is
addressed to the **attacker alone** — a global audience would tell the target
that a shot they never felt was fired at them. The web copy is second person
and never names a target for the same reason.

**Weapon condition.** `p_combat_weapon_condition` (combat migration
`0004_weapon_condition`; `(player_id, item_id)` primary key, `condition`,
`updated_at`) degrades over **both** time and use: `wearPerShot` per shot,
plus `decayPerPeriod` per elapsed `decayPeriodSeconds` computed lazily from
`updated_at` on every read. Lazily, not by a sweeper — a BullMQ worker
mutating condition would need an idempotency key tied to `job.id` (rule 1) for
no gain. A missing row means `PRISTINE` (100), so the table only ever holds
worn weapons.

Condition scales the weapon's declared `backfireChance` as a **multiplier**,
never an addend, so a weapon declaring `backfireChance: 0` stays at zero
however ruined it is — the same "an explicit zero survives" property
`accuracy: 0` already has. With the defaults (base 2, wear factor 3): 2% at
pristine, 8% at ruined. Repair is a gunsmith route in `combat`
(`POST /api/combat/repair`, priced at `repair.cost_per_point` per point
restored), deliberately not a shop route in `inventory` — the shop sells,
it does not service.

`combat/src/condition.ts` is two pure functions with `now` as a parameter and
no I/O, the same shape as `resolve.ts`, which is what lets the boundaries
(future `updated_at`, zero period, clamping at both ends) be tested
exhaustively.

**Decisions worth not relitigating:**

- **`p_combat_weapon_condition` declares no foreign keys**, matching
  `p_inventory_shop_stock` and `p_oc_*`. Its rows are written while two
  `player_stats` rows are held FOR UPDATE, so a `players` FK would take FOR
  KEY SHARE there (safe — `tx.locks.player` already orders that pair) but an
  `items` FK would open a player-then-item edge that exists nowhere else in
  the graph (rule 6). Declaring neither leaves the lock graph untouched. Rows
  orphaned by a deleted player or item are harmless: every read is by full
  primary key from a path that already loaded both, and they are never joined
  back.
- **A no-op repair returns 204**, not a body. `apps/web`'s `api()` maps 204 to
  `undefined`, so a client that parses the response would throw on it — the
  web client never does, because the repair button is hidden at condition 100
  and `repair.data` is never rendered. If that ever needs touching, drop the
  parse rather than fabricate a body.

**Cost of adding a `GameEvent` variant, learned here.** `player.backfired`
broke *three* places, not the two that are obvious: the two exhaustive
switches in `apps/web` (`lib/eventCopy.ts`, `ws/invalidation.ts`, which fail
with TS2366), **and** the `CORPUS` drift guard in
`apps/server/test/plugin-ctx-core-events.test.ts`, which only fails under the
integration suite. Two separate task reviews missed one each. A task that
widens the union must run the whole of `npm run verify`, not its own project.

### Car theft, garage and the police chase

Spec: `docs/superpowers/specs/2026-08-15-car-theft-garage-police-chase-design.md`.
The second of four clusters activating migrated-but-unread V2 tables
(`cars`, `theft_tiers`, `garage` — V2's four modules `cars`/`garage`/`theft`/
`policeChase` shipped as one GL3 plugin). Branch `feat/car-theft`. Like the
PvP combat cluster, this is not a port: the schema is the only V2-derived
constraint, so **the spec and the tests are the only specification of its
behaviour**.

**What shipped:**

- **`packages/plugins/theft`** — `GET /api/theft/tiers` (bracket metadata and
  car counts; does not spend the cooldown), `POST /api/theft/steal` (weighted
  draw over the tier's value bracket, weight = `theft_weight`), and the
  location-gated garage: `GET /api/garage`, `POST /api/garage/sell` (payout =
  value scaled by damage, bigint division truncating toward the house, through
  `applyBalanceChange`), `POST /api/garage/repair` (a pristine car is a 204
  no-op, the spec-1 gunsmith ruling). A failed theft runs the chase:
  escape (`escapeRoll < chase.escape_chance`) or jail via
  `tx.jail.sendToJail`, with `theft.resolved` published before the core
  `player.jailed` — the crimes ordering. Synchronous like combat: no job, so
  no rule-1 idempotency key to maintain. Steal/sell/repair take ids in the
  **body**, not the path — the declarative pages post through forms.
- **Two declarative pages** — `/theft` (tier table + one-select steal form)
  and `/garage` (car table + sell and repair forms) via the manifest `pages`
  field and `PageSchema`, rendered by the loader's page renderer rather than
  hand-written React in `apps/web`. Theft is the **first core plugin to
  declare `pages`** — every earlier plugin ships `adminPages` only. A view is static, so all data arrives
  through `table.source`/`optionsSource` GET routes; per-row buttons are not
  expressible in the ten-kind vocabulary, hence the select-then-submit shape
  the admin pages already use.
- **Core migration `0009_relinquish_car_tables`** drops `cars`, `theft_tiers`
  and `garage` — the `0007` precedent applied to the next three tables that
  qualified (shipped in core `0000` only because the core schema predated the
  plugin migration runner; no core code ever read them). The `theft` plugin
  now owns and creates `p_theft_cars`, `p_theft_tiers` and `p_theft_garage`
  with their foreign keys moved across verbatim, so **six of fifteen plugins
  declare migrations**. `apps/migrate` retargets through
  `pg/plugin-tables.ts`; its idempotency test keeps all 26 table entries,
  three now plugin-owned. `schema.test.ts`'s census moved with them:
  39 → 36 foreign keys, 29 → 28 non-PK indexes.
- **Lock order — locations-first, through the SDK helpers.** Inserting a
  `p_theft_garage` row reaches `locations` implicitly through the
  `location_id` FK; locking the player first would be the shipped travel
  deadlock exactly. Every theft path reads the location **unlocked**, locks it
  via `tx.locks.location`, then locks the player and **re-reads** — the
  lock-then-recheck TOCTOU defence (`409 wrong_location` for a mid-flight
  move, which also gates a pristine repair: wrong city beats no-op).
  `p_theft_cars` is a new lock-graph node that introduces no cycle: only
  theft's insert takes `FOR KEY SHARE` on one row last, and the admin
  catalogue editor holds exactly one `FOR UPDATE` — a transaction with one
  lock cannot be half of a cycle, so that route may not grow a second lock.
  Regression test `test/theft-lock-order.test.ts`, against the **real**
  bullets and travel routes as counterparties (the rule-6 corollary: same-helper
  participants prove only the safe case), demonstrated red against the
  inverted order first.
- **No new `GameEvent` variant** — a deliberate departure from bounties and
  organized crime. Theft publishes plugin events (`theft.resolved`,
  `theft.sold`) and reaches for `publishCore` only for the existing
  `player.jailed`. CLAUDE.md records what widening the union costs (three
  places break, one only under the integration suite); nothing about a stolen
  car needs to be indistinguishable from a core emission on the wire.
- **Admin**: `/api/admin/theft` with the car catalogue and the tier table —
  create and update for both, blank-means-unchanged names (the inventory
  admin convention), `minCarValue <= maxCarValue` enforced by a `.refine`,
  and no UUID rendered anywhere (ids travel only as `select` `valueKey`s).

**Cooldown is released on refusal, unlike combat.** Every refusal after the
claim is about the world (empty bracket, no location, mid-flight move), not
the target — a player must not pay for a world state they cannot see. A tier
lookup or empty-bracket 409 **before** the claim costs nothing either (the
crimes-plugin ordering).

**Settings** (`theft.*` namespaced by the SDK): `cooldown_seconds` (300,
floored at 1 — a zero TTL is the `travel_cooldown_seconds = 0` live crash, not
copied), `chase.escape_chance` (40, clamped 0-100), `chase.jail_seconds`
(600, flat not per-tier — tiers carry no ordering column),
`repair.cost_per_point` (500, bigint). `readTheftSettings` guards blank
strings explicitly because `Number("") === 0` would silently mean "zero"
instead of "use the default".

Eight new test files / 60 tests: `theft-resolve` (16, the pure resolver),
`theft-settings` (6), `theft-routes` (8), `theft-chase` (2), `garage` (13),
`theft-tiers` (2), `theft-lock-order` (3), `admin-theft` (10).

**A `testTimeout` lesson, learned on this branch's verification.** The first
full `npm run verify` of the cluster failed on nothing but
`theft-chase.test.ts`: both tests timed out at vitest's default 5000ms
(5391ms/5361ms), standalone they pass in ~1.96s. The file is the only one in
the cluster that boots `bootTestServer()` **inside each test body** — settings
are a boot-time snapshot, so each case's `theft.chase.*` rows must land before
its own boot — which puts `resetDb` (the multi-second TRUNCATE CASCADE) plus a
full boot against the 5s **test** timeout where every sibling file pays the
same cost in a `beforeEach` against the project's 30s **hook** timeout. Under
six-worker full-suite load the body crossed 5s. `apps/migrate/vitest.config.ts`
hit this exact failure before and fixed it with `testTimeout: 30000`;
`vitest.workspace.ts` now sets the same on the two Postgres projects
(`@gl3/server`, `@gl3/server:db-only`). Test-infra only — no production code
changed. `ledger.test.ts`'s 4.0-4.2s-of-5s watch item is closed by the same
change.

### Properties — location income, lazy accrual, one property per location

Spec: `docs/superpowers/specs/2026-08-15-properties-design.md`. The third of
four clusters activating migrated-but-unread V2 tables (`properties`).
Branch `feat/properties`. Not a port: the schema is the only V2-derived
constraint, so **the spec and the tests are the only specification of its
behaviour**.

**What shipped:**

- **`packages/plugins/properties`** — one property row per location (unique
  index on `location_id`, not a UNIQUE constraint — same guarantee, no
  drizzle-kit naming dependence). Player routes take the id in the **path**
  (`POST /api/properties/:id/buy|sell|claim`, `GET /api/properties`); admin
  routes keep ids in the body (form posts). Income accrues lazily:
  `accruedSince(lastClaimedAt, rate, cap, now)` computes whole hours ×
  `rate`, clamped at the `income.cap` setting, at read time — the claimable
  pool is never stored. `last_claimed_at` moves only on a claim that pays
  (a zero-claim answers `{claimed:"0"}`, touches nothing, publishes
  nothing — double-click safe). Sell pays `cost + accrued` (owner recovers
  the price plus banked income; a buyer pays `cost` only — there is no
  market). `profit` is lifetime income paid out, incremented at claim and
  at sell — a ledger of record, not a claimable pool. `plugin_id` is a
  dormant flavour label: stored, listed, admin-editable, selects nothing.
- **Events** — `bought`, `sold`, `income`, each published to the acting
  player (`audience: { kind: "player", playerId }`) with `invalidates:
  ["properties", "me"]` so the web page and the cash badge both refresh.
  No new `GameEvent` variant, no `publishCore` — plugin events only.
- **Core migration `0010_relinquish_properties`** drops the core `properties`
  table (the `0007`/`0009` precedent — shipped in core `0000` only because
  the core schema predated the plugin migration runner; no core code ever
  read it). The plugin owns `p_properties_properties` with FKs to
  `locations` (CASCADE) and `players` (SET NULL), so **seven of sixteen
  plugins declare migrations**. `apps/migrate` retargets through
  `pg/plugin-tables.ts` and stamps owned rows' `last_claimed_at` to
  migration time — migrated owners accrue from the move, not from 2015.
- **Lock order** — locations-first: every money route reads the row
  unlocked, takes `tx.locks.location(locationId)` then `tx.locks.player`,
  re-reads FOR UPDATE, and only then moves money. Regression test
  `test/properties-lock-order.test.ts` (barrier + 20×8 load against the
  real bullets and travel routes), demonstrated red against the inverted
  order first — the Postgres deadlock log names both statements.
- **Admin** — `/api/admin/properties` (list/create/update; update takes
  FOR UPDATE on exactly one row, the theft single-lock argument) plus
  `GET /api/admin/properties/locations` returning only unclaimed locations
  as the create form's select source. One declarative `adminPages` entry
  (`table` + create/update forms, no id column).
- **Player page — hand-written React**, unlike theft's declarative pages:
  the spec mandates it because per-row actions (buy only when unowned,
  claim with live accrued when yours, nothing when another's) are not
  expressible in the ten-kind page vocabulary. `apps/web/src/pages/
  Properties.tsx` with a pure `rowAction` function; the shared DTO lives
  in `@gl3/shared` (`PropertyRowSchema`, `PropertyListResponseSchema`,
  published as `0.1.3` — additive patch); `keys.properties()` =
  `["properties"]`, matching the manifest `invalidates` prefix.

**Settings** (`properties.*` namespaced by the SDK): `income.cap`
(1_000_000), `income.default_rate` (500 — wired into admin create's
fallback when `rate` is omitted; still parsed but unread by
`apps/migrate`'s `migrateProperties`, which hardcodes `500` instead),
`admin.can_edit_rate` (true — parsed but unread; spec §4 creates it for a
future runmode).

Seven new test files / 55 tests: `properties-settings` (7),
`properties-resolve` (10), `properties-routes` (18, including N13's two
income-cap tests), `properties-events` (4), `properties-lock-order` (3),
`admin-properties` (9, including N1's admin-create-default-rate test), and
the web `properties-page` (4, pure `rowAction`).

### Rounds — seasonal scoring window

Spec: `docs/superpowers/specs/2026-08-16-rounds-seasonal-design.md`. Branch
`feat/rounds`. Not a port and not one of the four migrated-but-unread-table
clusters: rounds is **core**, not a plugin — there is no relinquish
migration, and the plugin migration count stays **seven of sixteen**.

**What shipped:**

- **Lazy rollover under an advisory lock, no cron.** There is no job and no
  scheduler; `ensureCurrentRound(db, redis, settings)` runs at four call
  sites — `GET /api/rounds`, the leaderboard routes, and once at server
  boot (`index.ts`, between `loadSettings` and `loadPlugins`, deliberately
  outside `buildApp` so a boot-time rollover can't race round assertions
  under the integration tests; it absorbs the expensive case of a server
  that was down across several scheduled windows). The admin section is
  **not** a caller: `GET /api/admin/rounds` and its `/table` twin read the
  `rounds` table directly, without the lock, because a listing a few
  milliseconds stale is not a correctness problem. Every call does nothing
  on the common path — a live, already-snapshotted round returns
  immediately with no transaction and no lock wait (proven by a
  foreign-session-holds-the-lock probe with a hard timeout). When the
  current round has ended, it opens a transaction, takes
  `pg_advisory_xact_lock(7461002)` first, freezes the round's final
  standings into `round_entries`, pays out, publishes, and activates (or
  opens) the successor — all under the one lock, so N concurrent callers
  produce one settle and N−1 no-ops rather than N racing finalizes. A
  migrated V2 install's entire round history is settled in place by
  migration `0011`'s own `UPDATE`, not cascade-finalized on first boot.
- **Points, not cash.** The payout (`payoutPoints`, a settings-driven award
  table keyed by final placing, default `[1000n, 500n, 250n]`) pays into the
  `points` balance through `applyBalanceChange` — the one balance kind with
  no leaderboard ZSET and no existing faucet, so a round's prize cannot move
  any board the *next* round measures (paying cash or bank would inject a
  head start into the exact economy about to be re-scored; `exp` is not
  payable at all without corrupting the pure-activity board). Every payout
  row carries `balance_kind = 'points'`, `ref_id = <round id>`, and a null
  `job_id` — there is no BullMQ job here, so no `job.id` idempotency key
  applies; the advisory lock is what makes settle-exactly-once.
- **`round_entries` is the hall of fame — there is no separate winners
  table.** One row per player per round: `exp_at_start` / `cash_at_start` /
  `bank_at_start` snapshot the player's totals at registration (mid-round
  joiners start at their own values, not the round's, so standing reads 0
  immediately on join), and `final_exp` / `final_cash` / `final_bank` freeze
  at settle. A player who never made a request in the round still gets an
  entry (the whole-population snapshot on activation), and with zero
  `rounds` rows registration writes nothing and leaves `players.round_id`
  null.
- **Four new core files** under `apps/server/src/game/rounds/`:
  `service.ts` (`ensureCurrentRound`, the lock/freeze/pay/publish/activate
  sequence), `settings.ts` (`payoutPoints`, the award-table parser with a
  hardcoded fallback on an unparseable setting), `standings.ts`
  (`roundStandings(exec, roundId, kind, n, finalized, minDelta?)`, the
  live-vs-frozen board query), and `routes.ts` (player-facing `GET
  /api/rounds`). All-time leaderboards are unmodified: `keys.leaderboard`,
  `recordScore`, `rebuildLeaderboards` and `topN` stay exactly as they were,
  pinned by an edit to `leaderboard.test.ts` rather than to the ZSET code.
- **Two new `GameEvent` variants** — `round.started` and `round.finished`
  (with a `winners[]` array of `{ playerId, username, placing, points }`) —
  travel as core events, not `plugin.event`, matching rounds' core status.
  This is the fourth place a new variant must reach, alongside
  `eventCopy.ts`, `invalidation.ts` and the `CORPUS` drift guard in
  `plugin-ctx-core-events.test.ts`: `packages/shared/test/events.test.ts`
  carries its own hardcoded census of every core name, missed by this plan
  and caught only when the whole-tree `npm run verify` ran (see CLAUDE.md).
  `@gl3/shared` picked up an additive patch bump, `0.1.3` → `0.1.4`, for
  these two variants plus the new `dto/rounds.ts` exports;
  `@gl3/plugin-sdk` needed no bump, since its `CoreEventInput` derives from
  `GameEvent` rather than restating it.
- **Admin section** — `/api/admin/rounds` (list/create/update, table +
  forms, no id column: the edit form's select `valueKey` carries the round
  id, the row shows its name) with write-time overlap rejection
  (`400 round_overlap`) guarded by the same advisory lock family the
  rollover itself uses, so two concurrent creates of the same window leave
  exactly one row. `GET /api/admin/rounds/table` is the pre-stringified
  twin `PageRenderer`'s `table` view consumes.
- **Player page** — `apps/web/src/pages/Rounds.tsx`, plus a scope toggle
  (`?scope=all` vs the round-local default) added to the existing
  Leaderboards page so a round-scoped board and the all-time ZSET board
  share one view.
- **Core migration `0011_round_entries`** — the eight statements of spec
  §1.5.3: two `ALTER TABLE rounds ADD COLUMN` (`finalized_at`,
  `snapshotted_at`), the `round_entries` table with its composite
  `(round_id, player_id)` primary key, two cascade FKs (`round_id ->
  rounds.id`, `player_id -> players.id`), two indexes
  (`round_entries_player_idx`, and the partial `rounds_open_idx` on
  `rounds(starts_at) WHERE finalized_at IS NULL`), and the settle-the-past
  `UPDATE` — deliberate DML, not a stray backfill, and the one thing that
  stops a V2-migrated install cascade-finalizing its whole round history on
  first boot. `apps/server/test/schema.test.ts`'s FK/index drift guards
  moved with it: total FKs 34→36, `ON DELETE CASCADE` 21→23 (`SET NULL`
  unchanged at 13), non-PK index count 27→29.

Ten new test files / 92 tests: `rounds-settings` (10), `rounds-standings`
(12), `rounds-finalize` (10), `rounds-snapshot` (6), `rounds-ledger` (1, a
whole-file reconciliation across a rollover), `rounds-rollover` (1, the
8-concurrent-callers exactly-once proof), `rounds-lock-order` (2, the
rounds↔player pair — the fourth lock pair in the codebase after
gang↔player, location↔player and player↔player — proven against real bank
and combat routes behind a `pg_stat_activity` barrier, not a same-helper
race), `rounds-routes` (13), `admin-rounds` (28 — one static `it(` call
site inside a `for (const g of geometries)` loop expands to 5 runtime
tests over the five colliding geometries, so a source-line count of `it(`
finds 24 and undercounts by exactly that loop's width; the geometries
array and the loop are both in the "overlap rejected at write time" block,
including the two-concurrent-creates overlap proof), and the web
`rounds-page` (9). Net
tree total: **177 files / 1370 tests**, up from 167/1269 — the other nine
tests are edits inside existing files (`leaderboard`, `event-copy`,
`invalidation`, `admin-ids-hidden`'s floor raised to 10 sections).

### Properties as franchises — `plugin_id` goes live, income becomes consumer-paid

Spec: `docs/superpowers/specs/2026-08-16-properties-franchise-design.md`
(supersedes, in part, `2026-08-15-properties-design.md` above). Plan:
`docs/superpowers/plans/2026-08-17-properties-franchise.md`. Branch
`feat/properties-franchise`. Not a port: the V2 source was read after the
income-accrual cluster shipped and turned out to describe a different
mechanic, so the spec and the tests remain the only specification of this
cluster's behaviour.

**Phase 0 — a live M4 defect, independent of the rest.** The migrator read
`PR_owner`; the real V2 column is `PR_user` (`0` = unowned, `-1` = "closed").
Against a real V2 database the migrator died with `Unknown column 'PR_owner'`
— hidden until now because the test fixture had been reconstructed from the
same wrong `SPEC.md` line. `apps/migrate/src/migrators/properties.ts`,
`SPEC.md:75` and `:165`, and the fixture DDL are all corrected.

**Phase 1 — `plugin_id` becomes a declared, validated thing.** A new manifest
field, `providesProperties: PropertyTypeDecl[]` (`id`, `name`, `price`,
`leverLabel`), collected by the loader into a registry exposed on **every**
plugin's ctx as `ctx.propertyTypes` — not only the properties plugin's own;
the spec was amended in place to say so, since the registry is the same
loader-derived data `GET /api/plugins` already serves publicly. The table's
key moves from `unique(location_id)` to `unique(location_id, plugin_id)`
(plugin migration `0004_location_plugin_unique`), so a casino and a bullet
factory now coexist in one town. Admin edits `plugin_id` as a select over the
registry instead of free text.

**Phase 2 — income comes from the consumer, not a clock.** `rate` and
`last_claimed_at` are dropped along with the `claim` and `sell` routes —
there is no accrual any more. `cost` is reinterpreted from purchase price to
**the owner's lever**: `0` means "unset, consumer uses its own default"
(existing values are zeroed on migration, since a purchase price would be
nonsense as a lever). `@gl3/plugin-properties` exports `ownerAt` and
`payOwner` for any consumer plugin to depend on, the same
declare-a-dependency shape `bounties` already uses on `combat`. Five player
routes replace the old three: `buy` (by `pluginId` + `locationId`), `lever`,
`transfer`, `drop`, `reset`. `bullets` becomes the first consumer — a new
dependency on `@gl3/plugin-properties`, **the second plugin→plugin
dependency edge in the codebase after `bounties`→`combat`** — reading the
owner's lever as price-per-bullet (falling back to the location's own price
when unset) and paying the owner half of every sale via `payOwner`.

**Two deliberate divergences from V2, both flagged for review rather than
silently matched to spec:**

- **Seizure on death disowns rather than transferring to the shooter.** V2's
  `propertyManagement.hooks.php` hands every property the victim owned,
  game-wide, straight to the shooter. GL3 does not: the shooter already takes
  the kill's payout, and a franchise on top of that compounds a winner's
  lead. Instead every property the victim owned becomes unowned — back on
  the market at the declared price for anyone, seized in the investigation.
  It also does not publish a plugin event: `properties` subscribes to
  `combat.killResolved`, and `runFilterChain` (SDK) passes the **applying**
  plugin's ctx to a subscriber, not the subscriber's own — a `tx.events.
  publish` inside this subscriber would go out labelled `toEnvelope("combat",
  …)`, an event combat never declared and no plugin-event invalidation could
  match. The subscriber calls `tx.notify` instead, which always publishes the
  core `notification.created` event. Cost: `notification.created` doesn't
  invalidate the properties list, so a seized player's page only refreshes on
  their next visit — accepted as a reasonable trade-off rather than growing a
  new core `GameEvent` variant for one notification. The manifest declares
  exactly three events — `bought`, `dropped`, `transferred` — and no
  `seized`.
- **`drop` refunded nothing** as this cluster shipped, matching V2's plain
  `DELETE`. That has since changed — see "Property board, drop refund and the
  bankruptcy takeover" below: it now pays back half the declared price and the
  page confirms first.

**Package versions.** `@gl3/plugin-sdk` took its **first bump ever**,
`0.1.0` → `0.1.1`, for `providesProperties` and `ctx.propertyTypes`.
`@gl3/shared` went `0.1.4` → `0.1.5`: `PropertyRowSchema` and
`PropertyListResponseSchema` change shape (`accrued`/`rate` out,
`lever`/`price`/`typeName` in) — breaking in shape, but shipped as a patch
under the same `0.x`-additive reasoning as every prior bump, since no
external consumer of either symbol exists yet. **Both have since been
published**, with the user's approval, following this branch's commit — the
registry now serves `@gl3/shared` `0.1.1` through `0.1.5` and
`@gl3/plugin-sdk` `0.1.0` and `0.1.1`.

**Test files.** Six new: `properties-consumer-lock-order` (1, the second
player↔player lock-order regression after combat's own — proves a consumer
that calls `payOwner`, e.g. bullets buying from an owned factory, locks
buyer and owner in one sorted `tx.locks.player` call rather than two),
`bullets-property` (5), `properties-pay-owner` (7), `properties-seizure` (5),
SDK `property-types` (6), and server-unit `property-type-registry` (3) — 27
tests. Two deleted with the accrual model: `properties-settings` (7) and
`properties-resolve` (10). Existing files' net test-count changes:
`properties-lock-order` +1 (3→4, now covering `transfer`'s ABBA rather than
`claim`/`sell`), `properties-routes` −5 (18→13, fewer routes), `properties-
events` −1 (4→3, one event's `describe` changed and `income` — never a real
event — left with the accrual model), `admin-properties` +2 (9→11). Net at that point:
**+4 files / +7 tests**, taking the tree from 177/1370 to 181 files / 1377
tests. The final review's fix wave (`4bf2fd7`) then added 3 more tests across
`admin-properties`, `properties-lock-order` and `properties-routes`, giving
the **181 files / 1380 tests** the green full run reports; `4bf2fd7` and the
two doc commits after it are the only changes between the two runs, so the
+3 attributes there by elimination.

**Verification — read this before trusting a green claim for this branch.**
The first bare full `npm run verify` after all ten implementation tasks
landed came back **exit 1**: 2 files / 2 tests failed out of 181/1377.
Neither was a drift-guard count (`schema.test.ts` held at 36 FKs / 29
indexes, exactly as predicted — every migration on this branch is a
*plugin* migration, and that census counts only core-created objects in
`public`). Both were real branch defects invisible to any task's own scoped
run:

1. `test/economy-invariant.test.ts` calls `bulletsPlugin`'s routes directly
   via `callPluginRoute` (no `bootTestServer`) and migrates only
   `[inventoryPlugin, combatPlugin, detectivesPlugin]`. Making `bullets` a
   `properties` consumer meant every `/api/bullets/buy` call now reads
   `p_properties_properties` unconditionally through `ownerAt` — a table this
   file never migrated, so it 42P01'd. Fixed by adding `propertiesPlugin` to
   its migration list, with a comment recording why; `bullets.test.ts`
   already needed the identical fix during Task 9 and was not itself broken.
2. `test/plugin-manifest-endpoint.test.ts` hardcodes the full expected
   `events` payload `bootTestServer()`'s `CORE_PLUGINS` merge produces. It
   was never updated for Task 5's `bought` describe-string change or Task 7's
   new `dropped`/`transferred` events — a hand-maintained census with no
   type-level tie to the manifests it asserts against, so it drifts silently
   and only a full run (needs Postgres/Redis; no scoped run selects it)
   catches the gap. Fixed to the current truth, with a comment recording why
   it drifted and confirming there is deliberately no `seized` event.

Both fixes were first verified **scoped** — at the user's explicit direction,
after the full run was killed mid-flight to avoid a second multi-minute pass
for a two-file change: `npx vitest run --project @gl3/server
test/economy-invariant.test.ts test/plugin-manifest-endpoint.test.ts` (exit
0, 2 files / 8 tests passed) and `npm run verify:related` (exit 0, 130 files
/ 1138 tests passed, typecheck clean).

**The owed full run has since been made, and it is green.** A bare
`npm run verify` on HEAD `e7ea8af` exited 0: `Test Files 181 passed (181)`,
`Tests 1380 passed (1380)`, no unhandled rejections, and no void files — the
only two `(0 test)` entries are `@gl3/plugin-sdk`'s `.test-d.ts`
typecheck-only files, which have no runtime cases by construction. This is
the branch's single green full-suite run and it supersedes the exit-1 run and
the scoped reconfirmations above. Note the run *before* it was void rather
than failing (`Tests 1307 passed`, zero failures, 22 real test files at
`(0 test)`, a long-running-hook warning) because a concurrent session was
driving the same Postgres and Redis — isolation on this machine needs a
separate *database*, not a separate worktree.

### Casino engine and blackjack — a game is a filter subscription

Spec: `docs/superpowers/specs/2026-08-17-casino-blackjack-design.md`. Plan:
`docs/superpowers/plans/2026-08-17-casino-blackjack.md`. Branch
`feat/casino-blackjack`. SPEC §6 listed the casino as v1.1 — "ship the schema,
stub the gameplay"; the schema shipped in M0 and the stub was never filled.
Everything about *money* follows V2's `blackjack.inc.php` (`:124` the
hardcoded $1,000,000 property, `:276` `PR_cost` read as the maximum bet,
`:297` the wager credited to the owner, `:406` the payout debited from it);
everything about *cards* is GL3's own, so the tests are the only specification
of the rules.

**Two packages, not one, and the split is load-bearing.**
`@gl3/plugin-casino` is the hub — the `p_casino_sessions` table, escrow,
payout, house resolution, the lobby and the extension point — and declares
**no** property type. `@gl3/plugin-blackjack` is the first game — pure rules,
no tables, no routes — and declares the house through `providesProperties`.
Naming the game plugin `blackjack` is what makes a migrated V2 database's
`plugin_id = 'blackjack'` property rows light up on install, owner and lever
intact; naming it `casino` would have stranded them permanently. The hub
declaring no type is what keeps "who is the house" unambiguous: for a hand of
game `G` in town `T` the house is the owner of `(T, G)` and nobody else. That
takes the repo's plugin→plugin dependency edges from two to four
(`casino → properties`, `blackjack → casino`); the graph stays acyclic and
the franchise design's "look again at the third edge" was done and recorded in
the spec — re-examine at edge six. **Eight of eighteen plugins now declare
migrations**, up from seven of sixteen: casino's `0001_sessions` and
`0002_one_open_session` are the only new ones, and a game plugin owning no
tables *by design* is what lets a
third-party game ship without a migration runner touching the database.

**The extension point is a filter, not a manifest field.** The hub exports
`games = filterPoint<GameDef[]>("casino.games")` and a game subscribes with
`on(games, (_ctx, list) => [...list, MY_GAME])` — `bounties → combat`'s
`killResolved` shape exactly. Chosen over `providesCasinoGames` because
filters already carry functions and are already collected by the loader, so
the whole extension point costs no SDK surface and no republish, and a generic
SDK gains no casino-shaped field. The price, recorded as a known risk: a
`GameDef` arrives inside a subscription, so `definePlugin` cannot validate its
id the way it validates `providesProperties` — the hub builds its registry per
request and throws on an id that is not an installed plugin id or that
collides. That is a request-time failure where the property registry gets a
boot-time one.

**`GameDef` gained a fourth member during implementation**, and from an
unpredicted direction: `view?(state)`, forced by the **hub** rather than by a
second game. §4.2's lobby has to redraw an in-progress hand from stored state,
and nothing could — a `ViewNode` was otherwise reachable only inside a
`GameStep`, `state` is opaque game-owned jsonb, `act` cannot peek because
every action mutates, and the hub must not import a game to render it. Spec §3
was amended in place. Optional, so a game that omits it resumes viewless
rather than failing to install.

**Sessions and money.** One `p_casino_sessions` row per hand, with a partial
unique index on `(player_id) WHERE status = 'open'` — one open hand per player
**across all games**, OC's one-active-heist shape, which is what makes the
escrow accounting single-threaded per player. The wager is escrowed at `play`
(player debited, house credited through `payOwner`) so the net across a hand
is correct with no second bookkeeping concept: a push returns the wager, a
loss returns nothing. There is no settle route — a hand settles inside
whichever call returns `done: true`, so a one-shot game opens and settles in a
single `play`. An unowned town is a real, specified case rather than an edge:
the escrow sinks and the payout is a faucet, bounded by the `max_bet` setting.
Abandoned hands expire lazily (`session_expiry_minutes`): the lobby hides one,
the next `play` forfeits it, and `act` refuses it — no cron.

**The house exposure check is the load-bearing money guard.** `payOwner`
*clamps* a debit to the owner's cash, so without an up-front check a player who
wins more than the house holds is silently short-paid, with no error anywhere
and a ledger that still balances. `assertHouseCanCover` runs before the wager
is taken and again on every `wagerDelta` (blackjack's double), because a
doubled hand is still 2.5× of the *current* wager.

**Lock order (rule 6).** Casino is a locations-first cluster, joining bullets,
theft and properties: `tx.locks.location` → **one** deduped, sorted
`tx.locks.player([player, owner])` → the session row `FOR UPDATE` → `payOwner`
(a no-op re-acquisition). The single call for both players is what makes
owner-plays-at-own-table safe against a second player at the same table;
locking the player first and letting `payOwner` take the owner second is the
ABBA cycle `properties/src/api.ts:51-58` documents.
`apps/server/test/casino-lock-order.test.ts` proves it with participants that
do **not** all acquire through the same helper, and its deliberate-inversion
red was a real `40P01` read out of the Postgres server log — Fastify strips
the pg code, so the response body never shows it.

**A `cards` view node** (`{ kind: "cards", cards: ["Sq","H2","B1"] }`, twelfth
kind) is the reason an installed third-party game is not second-class: rules
extensibility is solved by the filter point, and without a card node UI
extensibility is not — a game that cannot ship React into our bundle could
only render a hand as text. `@letele/playing-cards` (CC0, 0.1.0, abandoned
2023) supplies the SVGs; it ships **no type declarations** despite its
manifest naming some, and is **not resolvable by bare Node** (only a `module`
field), so it needs an ambient declaration enumerating all 56 exports and a
`resolve.mainFields` restoration on the `@gl3/web` vitest project. Only its
assets are relied on, and the licence means they can be vendored if it ever
breaks. The whole deck lands in the bundle (860.86 kB, 266 kB gzip, over
Vite's 500 kB warning) — shrinking it needs a lazy import or vendoring and is
follow-up, not part of this cluster.

**No events per hand.** One event per blackjack hand floods the feed — the
same reasoning that killed the franchise design's `income` event. Each route
returns the current view directly, so there is no invalidation to trigger
either, and no new core `GameEvent` variant, so the four-places rule does not
fire.

**Package versions.** `@gl3/shared` `0.1.5` → `0.1.6` (`dto/casino.ts`, plus
the `cards` leaf that Task 1 added to the SDK's `ViewNodeSchema` and never to
shared's `ViewNodeDtoSchema` — a real defect: `PluginsPayloadSchema.parse` is
all-or-nothing, so a declared page carrying a `cards` node would have taken
down the entire plugin payload, nav included). `@gl3/plugin-sdk` `0.1.1` →
`0.1.2` (the `cards` leaf; `installedPluginIds` on `PluginCtx`, which nothing
carried and `buildRegistry` needs) and then → `0.1.3`, a third publish
tightening its own `"@gl3/shared"` range from `^0.1.0` to `^0.1.6`. That range
documents the coupling and cannot enforce it: the parse that actually fails is
in the **browser bundle**, whose copy of shared comes from `apps/web`'s own
dependency, not from the SDK's tree. The durable fix is
`packages/plugin-sdk/test/view-node-parity.test.ts`, which reads both leaf-kind
sets back out of the schemas (a `discriminatedUnion` reports `issue.options`)
rather than restating a third hand-maintained copy, and runs in CI's
`verify:ci`.

**Suite.** 195 files / 1499 tests, `npm run verify` **exit 0** — the exit code
read from the process itself, not the summary line and not the harness's own
completion status. That distinction earned its keep on this branch: the run
before this one reported "completed (exit code 0)" while the real code was
**1**, because the command ended in `; echo "exit=$?"` and the shell returned
`echo`'s status. One test was red — `casino-lock-order`'s ABBA case, a bare
500 on `lockPlayersForUpdate` with no SQLSTATE — and the summary line alone
would have shipped it.

That failure is **unexplained and recorded as open**, not cleared. It did not
recur on the green run, but "it passed the second time" is the weakest
possible clearing: it is 5/5 green standalone and 3/3 green under deliberate
eight-file contention, so it needs full-suite density, and the log carried no
`40P01`, no `PostgresError` and no dropped connection — so the cross-talk
explanation that covers `properties-lock-order`'s round-19 failure does not
cover this one. Two failures of the same shape (a bare 500 on a `FOR UPDATE`
under full-suite load, in two different files) are now on record.
`routes.ts` logs the driver error's `cause` from this branch on, which is the
one datum both diagnoses lacked.

**The suite got 3.5x faster on this branch** and it was not an optimisation
hunt — the wall clock became the obstacle. `resetDb` truncated one table per
statement: 1.32s against 41 *empty* tables, all of it 39 separate WAL flushes
and lock acquisitions. One `TRUNCATE a, b, c ... CASCADE` costs 0.25s. ~87
files call it, most per test, so it landed on the majority of 776 integration
tests. Test time 5872s → 1481s, wall 1000s → 269s. Measured, not guessed:
argon2 was 42ms a hash and `bootTestServer` was already memoised per file —
the same "argon2id is slow" red herring this repo has recorded once before.
Note the speedup raises concurrency *density*, which is a plausible reason a
latent contention bug surfaced on the run above.

**The final whole-branch review found what eleven task reviews could not,**
and it is worth recording why: nothing on the branch asserted view *content*.

- **The dealer's hole card was never hidden.** `renderState` emitted both
  dealer cards and the dealer's true total at every phase, including while the
  player was choosing hit/stand/double — worth roughly +7-10% EV, which
  inverts the house edge against a player-owned franchise. Task 1 put the
  face-down backs `B1`/`B2` into all three card vocabularies and Task 5 wrote
  the view without them; they were dead code from the day they shipped, and no
  test could break when it was fixed. `blackjack-view.test.ts` (6 tests) now
  covers the pure `start`/`act`/`view` surface and `casino-act.test.ts`
  asserts what crosses the wire mid-hand.
- **The hub bounded none of the figures a `GameDef` returned.** Spec §3 says a
  game "cannot get money wrong, because it never touches money", which holds
  only if the hub bounds what it is handed: a payout above
  `maxPayoutMultiplier × wager` was credited in full while the house leg was
  clamped, minting the difference (a pure faucet in an unowned town); a
  negative `wagerDelta` turned escrow into a credit; a non-finite multiplier
  threw a RangeError out of `BigInt()`. `resolvePayout` is now the one place
  `game.settle` is called, and `exposureOf` the one place the cap is computed.
  Blackjack does none of these — this was the gap between the trust boundary
  the spec claimed and the one that existed, which matters because the next
  game comes from a stranger. `casino-rogue-game.test.ts` (6 tests) installs a
  deliberately hostile game through the real filter point and asserts the hub
  refuses it.
- **A game's own zod rejection and any thrown `Error` were 500s.**
  `game.action.parse` inside the handler and blackjack's two `throw new
  Error(...)` calls all reached `routes.ts`'s re-throw, where this repo's rule
  is that an unvalidated boundary returns a clean 400. Now `invalid_action`
  and `game_error` (carrying the game's own message as `detail`); the lobby's
  `view` degrades to `null` on a throw rather than taking down the whole
  response. The web page's workaround — Double withheld on any resumed hand,
  because an illegal one could only 500 — is gone with it.
- **`session.property_id` was written and read by nothing.** `act`
  re-resolved the house every call, so a town unowned at `play` sank the wager
  and then debited the payout from whoever had bought the table since.
  `frozenHouse` resolves by the stored id. The freeze pins the **row, not the
  person**: a `transfer` moves `owner_player_id` on the same row and hands the
  open position over with the table. Spec §4.3 was amended to say exactly that
  rather than keep claiming more than the code delivers.

**Known gaps, deliberately left.** `withCorePlugins` silently drops an
optional plugin whose id collides with a core one — it cost this cluster two
red tests whose message pointed nowhere near the cause, and the same collision
could silently drop a third-party plugin in production; a boot-time throw or
warn looks right, but it is a core loader change, not a casino one.
`adminSessionsRoute`'s `openedAt: row.createdAt.toISOString()` throws
`RangeError` on an Invalid Date — unreachable through any exposed surface
(`created_at` is `.notNull().defaultNow()`, no route accepts it, and M4 never
touches this table), so a guard there would be dead code no test could
justify.

### Weapon DPS paces the attack cooldown

A small combat tweak, not a cluster: no migration, no new table, no plugin, and
no `@gl3/shared` or `@gl3/plugin-sdk` change (item `effects` crosses the wire as
`z.unknown()` and is parsed on each side, so a new field needs no DTO).

The attack cooldown used to be one flat number for every weapon
(`combat.cooldown_seconds`, 60). Weapons now declare `dps` in `items.effects`,
and the cooldown is the weapon's **average** damage divided by it — 10 damage at
1 dps waits 10 seconds, the same weapon at 0.5 dps waits 20. The average, not
the roll, because the cooldown is claimed *before* the transaction that rolls
damage (the ordering that denies a client a free probe of who is attackable), so
the roll does not exist yet when the TTL must be chosen; averaging also makes a
weapon's rhythm a property of the weapon rather than of luck.

- `cooldownSecondsFor` (`packages/plugins/combat/src/cooldown.ts`) is pure with
  respect to time and RNG, like `resolve.ts`, and tests in the no-DB
  `@gl3/server:unit` project (`test/combat-cooldown.test.ts`).
- **A weapon declaring no `dps` keeps the flat cooldown.** Every migrated V2
  item is in that case — `itemEffects` has no such column — so the live game
  paces exactly as it did. Same optional-field shape as `accuracy` and
  `backfireChance`.
- Two clamps, both load-bearing: a floor of 1 (Redis `SET ... EX 0` fails — the
  `travel_cooldown_seconds = 0` crash below) and a ceiling from the new
  `combat.cooldown_max_seconds` (3600), without which `dps: 0.001` on a
  10-damage weapon is a near-three-hour lockout from one admin typo.
- Fists are paced by `combat.unarmed.dps`, absent by default. It is read by a
  new `rate()` reader because the existing `num()` **floors** — a floored 0.5 is
  0, which reads as "unpaced".
- The route reads the equipped weapon's pacing in its own **read-only, lock-free
  transaction** before claiming the cooldown (`cooldownForAttacker`), since the
  attack transaction does not load the weapon until far too late and the ctx
  exposes no database outside a transaction. A weapon swapped between that read
  and the shot is paced as the old weapon: accepted, and cheaper than handing
  back the free probe.
- `dps` is settable and visible in the inventory admin section (a `decimal`
  form field — a `number` input's default `step="1"` refuses 0.5 — plus a table
  column), and non-positive values 400 at the route rather than dividing by zero
  downstream. `effects.ts` is the hand-kept verbatim copy pair, so the field
  went into **both** `combat` and `inventory`; `test/effects-parity.test.ts`
  enforces that.
- The player-facing `/inventory` and `/shop` weapon lines read
  `10–20 damage · 0.5 dps`, through one shared pure `weaponStatLine`
  (`apps/web/src/lib/effects.ts`) — shared so the two pages cannot drift, and
  pure because neither web project has a DOM to render a component in, so a
  helper is the only part of a stat line a test can reach. A weapon with no dps
  omits the clause rather than showing a zero. The pages show the **dps**, not
  the derived wait: the server clamps that wait against
  `combat.cooldown_max_seconds` and falls back to `combat.cooldown_seconds`,
  neither of which the client can see, so a recomputed figure would be
  confidently wrong at the edges.
- Not done, deliberately: `/combat` still shows no cooldown ahead of a shot.

**The merge gate, and the two things it took to get an honest number.** The
branch was cut from `8dfb995` and sat **47 commits behind** by the time it was
ready — the whole casino cluster landed on `main` in between. Gating the branch
as it stood would have graded code nobody was going to ship, so `main` was
merged *into* the branch first (`35c8ba7`; conflicts in `package-lock.json`,
where the branch carried stale `plugin-sdk 0.1.1` / `shared 0.1.5` echoes
against `main`'s `0.1.3` / `0.1.6`, and in this file, where both sides appended
a section at the same line). `vitest.workspace.ts` auto-merged and kept both
sides' `include` entries, which is the one auto-merge worth re-reading by hand —
a lost line there is silent (see the ninth registration site in `CLAUDE.md`).

A bare `npm run verify` on `35c8ba7` then **exited 0**: `Test Files 196 passed
(196)`, `Tests 1526 passed (1526)`, `Type Errors no errors`, no unhandled
rejections. The only `(0 test)` entries are `@gl3/plugin-sdk`'s two
`.test-d.ts` typecheck-only files, which have no runtime cases by construction —
so no void files and no cross-talk. The counts are higher than the branch's own
~183 files / ~1400 tests precisely because the merge pulled `main`'s casino
tests in, which is the point of gating the merge rather than the branch.

The run *before* it exited 1 with **36 failures across 25 files, every one of
them `@gl3/migrate`**, and none of them real: `MYSQL_ADMIN_URL` was not exported
alongside `DATABASE_URL` and `REDIS_URL`, so `requireEnv`
(`apps/migrate/test/helpers/fixtures.ts:19`) threw in each file's fixture setup.
`CLAUDE.md` already warned that this "reads like 36 real failures"; it is now on
record that it reads that way even to someone who has read the warning. The
tell is the shape — a whole project failing as a block, at setup, with one
identical message. Merged to `main` as `72a84be`.

### Bullets restock, admin options and the two caps

Design: `docs/superpowers/specs/2026-08-17-bullets-restock-design.md`.

`locations.bullet_stock` had three writers — the buy decrement, the admin
absolute-set, and the one-time V2 import — and no restock of any kind, so every
town drained monotonically to zero and stayed there. V2's `bullets.inc.php`
restocked hourly and that had never been ported.

- **`restockIfDue` ports `restock()` verbatim.** One global cursor
  (`bullets.last_restock`) floored to the hour, `hours = floor((thisHour −
  cursor)/3600)` clamped to **12**, an *independent* draw per location
  (`sum of randomInt(min, max+1)` over `hours`, defaults 2250/2750), and V2's
  40000 ceiling. `LEAST()` folds in V2's second statement, which also caps a
  row that was already over the max.
- **Lazy, under `pg_advisory_xact_lock(7461003)`, no cron** — 7461001 is the
  first-admin claim, 7461002 is rounds. Double-checked: the unlocked pre-read
  makes the common case (nothing due) one indexed row read and no lock; the
  re-read under the lock is what makes N racing shop views produce one restock
  and N−1 no-ops.
- **The trigger is a new `GET /api/bullets/shop`, and it had to be a read.**
  A core plugin cannot declare BullMQ jobs (`buildApp` throws), and hanging the
  restock off the *purchase* deadlocks the mechanic: `Bullets.tsx` disables the
  buy button at zero stock, so the buy that would refill the town can never be
  made. Hooking it into travel's `GET /api/locations` was rejected — wrong
  owner, and it would fire on travel page views.
- **RULE 6, and a new edge in the lock graph.** The restock is the first thing
  in the game to touch every location row in one transaction. It takes them
  `ORDER BY id ... FOR UPDATE`, ascending — the order `lockLocationsForUpdate`
  sorts into and travel already uses. Regression:
  `apps/server/test/bullets-restock-lock-order.test.ts`, whose adversary is
  hand-written raw SQL rather than the real travel route (the corollary: a test
  whose participants share a helper proves only the case that was already
  safe), **demonstrated red** against a `desc` variant — the shop 500s on
  `select "id" from "locations" order by ... desc for update`.
- **The shop route also fixes a live display bug.** The page rendered
  `locations.bullet_cost` while the buy route charged the franchise owner's
  lever, so an owned town showed a price it would not honour. `unitCost` is now
  the figure the purchase will actually cost.
- **Two caps, from V2's `method_options`.** `max_buy` refuses a purchase before
  the transaction opens (`quantity_above_max`). `max_cost` is enforced twice:
  rejected when the owner sets the lever (`lever_above_cap`) and clamped again
  when the price is charged, because the cap can be lowered after a higher
  lever was already accepted. Unset means unlimited for both — V2 passes no
  default there, and zero would mean "free" and "no purchase ever allowed".
- **The lever rejection is the fourth live filter subscription, and it cannot
  use `ctx.settings`.** `properties` gained a `properties.leverSet` point
  applied before its write; `bullets` subscribes. `runFilterChain` threads the
  *applying* plugin's ctx into every subscriber, so `ctx.settings.get("max_cost")`
  there resolves `properties.max_cost` — the same mislabelling trap already on
  record for `tx.events.publish` in a `combat.killResolved` subscriber. The
  subscriber therefore reads the `settings` row in its own transaction. Fixing
  the class properly (a ctx built for the *subscribing* plugin) was considered
  and left alone: it changes every existing subscriber's semantics.
- **Tunables stay a boot snapshot; the cursor cannot.** `loadSettings` reads
  once at boot and `ctx.settings.get` is synchronous over that record, so an
  options edit takes effect on the next restart — consistent with the nine
  other settings consumers, and the panel says so out loud. The cursor moves on
  every restock and is read and written through `tx.db`, making `settings` the
  plugin's third core-table mirror and GL3's first runtime settings *writer*.
- **Admin gained an Options panel and kept the stock form.** Travel's town
  admin edits only name/cost/cooldown, so bullets' section is still the only
  editor of `bullet_cost` anywhere. The direct stock setter stays as an ops
  override (a deviation from V2, where stock came from `restock()` alone),
  validated against `max_stock` and `max_cost`.
- **Migration parity needed a rename map.** `migrateSettings` copied `S_key`
  verbatim, so a migrated game would have landed flat keys
  (`bulletsStockMinPerHour`) that `ctx.settings.get` can never find — every
  operator's tuning silently reverting to defaults. Six keys are renamed into
  the `bullets.` namespace; the rename is a pure function of the key, so
  re-running still maps to the same row.
- **`@gl3/shared` → `0.1.7`** for `BulletShopResponseSchema` (additive).
  `@gl3/plugin-sdk` unchanged; both plugin packages are `private: true`.
  **Published to `npm.gl3.dev`**, with the user's approval, following this
  branch's commit — the registry now serves `@gl3/shared` `0.1.1` through
  `0.1.7`, `latest` pointing at `0.1.7`.
- Gate: bare `npm run verify`, exit code read from the process — **201 files /
  1568 tests, exit 0**, no unhandled rejections. Two hardcoded fixture counts
  failed first (`migrators/settings.test.ts` and `orchestrator.test.ts`, both
  `toHaveLength(3)` over the settings table) and neither was reachable from any
  scoped run — the same lesson the rounds cluster recorded.

### Installing a plugin without forking core

The optional-plugin import map used to be a hand-written literal in
`apps/server/src/index.ts` (`{ hello: helloPlugin }`), so installing a
marketplace plugin meant editing core server source — every operator forks
core, and every GL3 upgrade is a merge conflict in the one file they had to
touch. The map is now generated:

- **`scripts/generate-plugin-map.mjs`** (`npm run plugins:generate`, `--check`
  to assert freshness) walks the **direct** dependencies of
  `apps/server/package.json`, reads each installed `package.json`, and includes
  those declaring `"gl3": { "plugin": true }`. Direct-only stops a transitive
  dependency smuggling itself into the boot; a self-declared marker mandates no
  npm scope, so operators publish under their own. The 14 ported core plugins
  deliberately carry no marker — the marker means "optional, selectable via
  `PLUGIN_IDS`", and core ports load unconditionally via `CORE_PLUGINS`.
- **`apps/server/src/plugins/installed-plugins.ts`** is its committed output:
  imports plus one array, no logic. Committed so a fresh clone typechecks with
  no extra step and an install is a reviewable diff.
- **`apps/server/src/plugins/available.ts`** — `buildAvailablePlugins` turns
  that list into the id→manifest lookup, keyed by `manifest.id` (nothing
  asserts the package name and the id match). It throws naming **both**
  packages on a duplicate id; without that check one package silently shadows
  the other before `validatePlugins` ever sees the pair.
- **`.npmrc`** commits `@gl3-plugins:registry=https://npm.gl3.dev` — scoped,
  never a bare `registry=` line, and with no `_authToken` (public-read). Inert
  until a `@gl3-plugins/*` package is actually depended on. `Dockerfile.server`
  copies it in both stages before their `npm ci`.
- **`apps/server/test/plugin-map.test.ts`** (in `@gl3/server:unit`, so it runs
  in `verify:ci` with no DB) covers discovery against a synthetic tmpdir root,
  the identifier-collision and missing-package errors, the duplicate-id throw,
  and staleness of the committed map.

Installing a plugin is therefore `npm i` + `npm run plugins:generate` + commit,
and enabling it is `PLUGIN_IDS` — **for a from-source deployment**. See
"Dynamic plugin loading" below for the container path, which none of that
serves. Registry-installed plugins need **two**
registration sites, not the eight CLAUDE.md lists for workspace-local ones —
they ship built `dist/`, so no tsconfig reference, no `srcAliases` entry and no
Dockerfile COPY. Two latent defects were fixed on the way: `@gl3/hello-plugin`
and `@gl3/plugin-news` were imported by `apps/server/src/` but never declared
as dependencies, resolving only through workspace hoisting.

`@gl3/plugin-sdk` and `@gl3/shared` are published to `npm.gl3.dev` at `0.1.0`,
so a third-party plugin has an SDK version to declare a peer range against
(`"peerDependencies": { "@gl3/plugin-sdk": "^0.1.0" }`). Both dropped
`private: true` and gained `files`, `exports`, `publishConfig` and a `prepack`
that runs `tsc --build`. **`files` is load-bearing**: `dist/` is gitignored, so
without it npm falls back to `.gitignore` as `.npmignore` and publishes a
package with no build output. `@gl3/shared` must publish alongside the SDK and
first — `pages.ts` imports *values* from it, not only types.

**Publishing is now a standing obligation, not a one-off.** Both packages are
consumed here through workspace links (`"@gl3/shared": "*"`), so a change to
either is invisible to `npm run verify` *and* to the registry: the suite passes
against the workspace source while `npm.gl3.dev` still serves the old tarball,
and every third-party plugin resolving `^0.1.0` builds against that old copy.
Changing the public surface of either package therefore means bumping its
version and republishing (shared first). `^0.1.0` means `>=0.1.0 <0.2.0` at
`0.x`, so additive changes go out as patches and keep existing peer ranges
resolving; `0.2.0` invalidates them all. The first exercise of this was
`@gl3/shared@0.1.1`: `player.discharged` (commit `3b7e72e`) added the 22nd core
event variant after `0.1.0` was published, and the registry lagged the workspace
by that variant until the patch went out. `@gl3/plugin-sdk` stayed at `0.1.0` —
its own `src` was untouched, and its `"@gl3/shared": "^0.1.0"` dependency
resolves the new patch on its own.

**The registry lost its storage on 2026-08-15** and was rebuilt: `npm.gl3.dev`
had been running without a persistent volume, and attaching one reset it to
empty, taking the auth tokens with it. Both packages were republished onto the
fresh registry, so it now serves exactly `@gl3/shared@0.1.1` and
`@gl3/plugin-sdk@0.1.0` — `@gl3/shared@0.1.0` no longer exists, and an exact pin
on it 404s. Caret ranges are unaffected. The practical lesson is that the
registry is not the archive: the workspace source and these version numbers are,
and a lost tarball is recovered by republishing from the tag that produced it.

**`@gl3/shared@0.1.2` is published.** The money-ranks/backfire cluster widened
the public surface additively — the `player.backfired` event variant,
`WeaponConditionDtoSchema` and `RepairResponseSchema` in `dto/combat.ts`,
`moneyRankLabel`/`backfire` on `ProfileDto`, and `moneyRanks` on
`RankListResponse` — so it went out as a patch, keeping every `^0.1.0` peer
range resolving. `npm view @gl3/shared versions` now returns
`[ '0.1.1', '0.1.2' ]`; `0.1.0` is still gone for the storage-loss reason
above. `@gl3/plugin-sdk` stays at `0.1.0`: its own `src` is untouched and its
`"@gl3/shared": "^0.1.0"` dependency picks the new patch up by itself — the
same shape as the `0.1.1` release.

### Property board, drop refund and the bankruptcy takeover

Three player-facing corrections on top of the properties and casino clusters,
all from live play rather than from the plans:

- **`GET /api/properties` is the CURRENT TOWN's board, not the world's.** It
  read every row in the table and synthesised one buyable row per (declared
  type × *every* location), so a three-town game listed three of everything.
  It now reads `player_stats.location_id` first and filters both halves —
  real rows and synthetics — to that one location. A player who is nowhere
  (null `location_id`, or no stats row) gets an empty list rather than a 409:
  this is a read, and `buyRoute` already owns the 409 for acting without a
  location. **A property owned in another town is therefore not listed** —
  deliberate, chosen over "current town plus my properties anywhere". Its
  `lever`/`transfer`/`drop`/`reset` routes still work (none is gated on the
  caller's location), so nothing is unreachable by an API client; reaching it
  from the UI means travelling back. Tests: the synthesis test now expects
  exactly one location, plus a new "lists no row for a location the caller is
  not in".
- **`drop` refunds half.** `dropRefund(price) = price / 2n`, floored, and `0n`
  for a type whose plugin is no longer installed (there is no declared price
  to halve, and a property row stores no record of what its owner paid). The
  route answers `200 { refund }` where it used to answer `204`, the `dropped`
  event payload carries `refund`, and the web page confirms first — a two-step
  in the row ("Drop it for good? You get back X — half its price."), not
  `window.confirm`, since nothing else in this app opens a native dialog. The
  page's `dropRefundOf` and the server's `dropRefund` are the same arithmetic
  in two places on purpose: `apps/web` depends on `@gl3/shared`, never on a
  plugin package.
- **The bankruptcy takeover.** `assertHouseCanCover` refuses a hand the house
  cannot pay at `play` and on every raise, but the owner's cash can fall
  between that check and the settle, and `payOwner` then CLAMPS the debit —
  the winner was paid in full out of a faucet and the owner kept the table.
  Now `settleSession` READS `payOwner`'s return (`escrow` still discards its
  own, for the reason its comment gives), and on a shortfall calls the new
  `takeOverFrom` exported by `@gl3/plugin-properties`, which moves
  `owner_player_id` to the winner and zeroes `cost` — but only under a
  `FOR UPDATE` re-read proving the *expected* owner still holds the row. It
  answers `false`, never throws, for the row being gone or unowned ("an
  unowned house cannot go bankrupt" — it is a faucet with no cash to run
  out of), for somebody else owning it now, and for the winner being the
  owner. The player is paid in full in every one of those cases: the takeover
  is on top of the money, not instead of it. Both sides are told by
  `tx.notify` — casino publishes no event per hand — and the step response
  carries `houseSeized`, so the page can show the sentence
  `HOUSE_SEIZED_MESSAGE`. It is hub-level, not blackjack-level: every future
  casino game inherits it because the hub owns every ledger row.
  `@gl3/shared` → `0.1.8` for the optional `houseSeized` field (additive
  patch), **published** — the registry now serves `0.1.1` through `0.1.8`. Tests: three new cases in
  `casino-act.test.ts` (takeover, unowned house, owner-at-own-table), each
  shown red against a stubbed `takeOverFrom`.

### Game art (assets) — shipped on `feat/asset-images`

Images for everything, the first engine capability GL3 has that V2 never had.
V2's `install/schema.sql` declares no image column on `cars`, `items`,
`crimes`, `locations`, `weapons`, `ranks` or `properties`; the only picture in
the game is `US_pic`, a path into the theme directory. So there is nothing to
port and no migrator work — `player_stats.avatar_url` and `apps/migrate` are
untouched, because player avatars are explicitly out of scope along with all
other user-generated content (no moderation, no quotas, no takedown).

Four decisions shaped it:

- **Admin/creator art only.** Trusted uploads, so no abuse surface.
- **Per-install art, plugin-declarable.** A plugin declares slots in its
  manifest; adopting images costs a manifest line and NO migration.
- **Filesystem driver for dev/test, S3 for production.** Two real backends
  behind `StorageDriver`, not a mock.
- **A slot registry, not an `asset_id` column per entity table.**

The last one is the load-bearing one. Core migration `0012_assets` adds
`assets` (the blob: `sha256` unique, mime, bytes, width, height) and
`entity_assets` (`(scope, entity_id, slot) → asset_id`). **`entity_assets`
carries no foreign key on `entity_id`, deliberately.** The alternative — an
`asset_id` column on each entity table — would add an FK from every plugin
table into a core table, and a foreign key is a lock (rule 6, two shipped
deadlocks). This design adds exactly one FK, core-to-core, on a table no
gameplay path locks. Drift guard: FKs 36 → 37 (cascade 23 → 24), non-PK
indexes 29 → 30 (`assets_sha256_key`).

The price of that omission is orphan rows, paid by `assets/sweep.ts`:
`sweepUnreferencedAssets` collects assets nothing references (behind a
one-hour grace period, so a sweep landing in the upload-then-bind gap cannot
delete the image an admin is halfway through binding), and
`sweepOrphanedCoreBindings` drops bindings whose entity is gone — **core scope
only**, because core cannot enumerate a plugin's tables. A plugin that deletes
an entity owns the binding that pointed at it; that limit is documented rather
than papered over.

Keys are content-addressed — the sha256 IS the storage key — which makes dedup
free (the same art on two items is one object), makes
`Cache-Control: immutable` correct by construction, and makes a re-upload of
identical bytes return the existing row instead of a conflict.

Uploads are a **core** route (`POST /api/admin/assets`), not a plugin route:
plugin routes take a Zod-parsed JSON body, and pushing binary through that
contract would drag multipart into the SDK for every plugin. Raw bytes arrive
through per-type `addContentTypeParser` entries — which must be explicit,
because `app.ts`'s catch-all `*` parser reads unclaimed types as a STRING and
would corrupt every image silently. No `@fastify/multipart` and no `sharp`:
`assets/image.ts` sniffs PNG/JPEG/WebP and reads dimensions from the header in
pure TypeScript. Validation order is size → magic bytes → dimensions → hash,
and the declared content-type is checked AGAINST the bytes, so a `.php` renamed
`.png` is a 400. Write order is driver-then-database, so a crash leaks an
object (which the sweeper collects) rather than leaving a row pointing at
nothing.

Binding is separate (`PUT /api/admin/assets/bind`) and its permission is
`hasPermission(scope)`, **not** blanket admin: the `travel` grant sets town art
and cannot touch item art. An undeclared slot is a 400 — with no FK on
`entity_id`, that registry lookup is the only thing between a typo and a row
nothing will ever read.

SDK surface: `providesAssets: [{ slot, label }]` on the manifest (no `scope`
field — the loader derives it from the plugin's own id, so two plugins cannot
collide and none can declare another's slot), plus `ctx.assetSlots` and
`ctx.assets.resolve(scope, ids, slot)` / `.mine(ids, slot)`. `resolve` is
batched by construction: it takes an array and returns a Map, and there is
deliberately no single-id accessor, because a per-row lookup in a `.map()` is
an N+1 that stays invisible until a town has forty items in it. Cross-scope
READS are allowed (inventory renders core-scope item art); writes are not.

Three additive view-node changes, mirrored in both `plugin-sdk/pages.ts` and
shared's `ViewNodeDtoSchema` (the parity test enforces the pair): the `image`
leaf (`alt` required, not optional), `table.columns[].render: "image"`, and the
`assetBinder` admin widget. `assetBinder` is its own node rather than a form
with a file field because a form's `action` must sit under the declaring
plugin's basePaths and binding is a core route; the renderer knows its target
and does the two-step POST-then-PUT itself. The loader OVERWRITES its `scope`
unconditionally, and boot rejects one on a player-facing page.

Adopted in two places as proof: `theft` declares `car` and shows art in the
garage table and its admin section; core's own art section (`admin/assets-page.ts`,
granted by the `core` module key) binds `items`, `locations` and `ranks`, whose
images the `inventory` and `shop` routes resolve cross-scope and the two
hand-written pages render through `<GameImage>` — which owns the
placeholder-on-404 and a fixed box, so a missing binding never reflows a list.

**Follow-up (same branch), from a first look at the running game.** Three real
gaps, all reported by the user and all confirmed:

1. **`location` and `rank` were bindable with nothing rendering them.** The
   admin section shipped upload widgets for art no route resolved, so binding a
   town image wrote a row nothing read. Travel, ranks and crimes now resolve
   their core-scope art and the pages draw it.
2. **A thumbnail was a dead end.** `GameImage` is now clickable everywhere,
   opening a lightbox at natural size (Escape / backdrop / button to close),
   and `table.columns[].imageSize` lets a column ask for a bigger cell — the
   garage uses `md` rather than the 32px default.
3. **Most of the game has no rows to bind art to.** Jail, hospital, bank, the
   casino floor: pages, not entities. Per-row art could not express them at
   all, which was a hole in the design rather than a missing declaration.

(3) is answered by **singleton slots**: `providesAssets: [{ …, singleton: true }]`
binds against `SINGLETON_ENTITY_ID` (the nil UUID), so it reuses
`entity_assets`, its permission check, its cascade and its sweep — only the
admin widget (no picker) and the read (`ctx.assets.singleton`) differ. Because a
page's view is STATIC data built at boot, it cannot carry a URL an admin
uploaded afterwards, so a new `slotImage` node names its slot and the client
resolves it through `GET /api/assets/slot/:scope/:slot`.

Core declares 20 `page-*` singletons plus a per-row `crime` slot; the banners
render from ONE place — a route→slot map in `Shell.tsx` — rather than a
`<SlotImage>` inside nineteen page components, because a banner is chrome and
per-page wiring is exactly what produced gap (1). The admin art section is now
**built from the registry** (`buildAssetsPage`) instead of hand-written, so a
slot that exists is a slot an admin can fill, and an installed plugin's banner
gets a widget with no code change in core.

One bug worth recording: `collectAssetSlots` rebuilt each declaration field by
field and silently dropped `singleton`, so every plugin banner was unbindable
while the registry reported the slot as per-entity. It is a spread now, with a
regression test (`asset-slots.test.ts`).

`@gl3/shared` → `0.1.10` and `@gl3/plugin-sdk` → `0.1.5`, both additive patches.
Gate after the follow-up: 207 files / 1646 passed, 1 skipped, exit 0.

**Second follow-up: the rest of the slots.** A per-row slot is bindable only if
something can list the rows, and core cannot enumerate a plugin's table — so
the first cut could only bind plugin row art from that plugin's own admin page,
which `gangs` and `oc` do not have. `AssetSlotDecl` now carries its own
`entitySource`/`entityLabelKey` (contained to the declaring plugin's
`basePaths`, checked at boot, and refused on a singleton, which has no rows),
so core's derived art section renders a picker for **every** slot in the game.
Added: `theft:tier`, `gangs:logo` (with the plugin's first admin route),
`oc:role-*` ×4, `blackjack:table`, and a `property` singleton on each property
provider — art per property TYPE, since every casino in the game is one
franchise. `@gl3/shared` → `0.1.11`, `@gl3/plugin-sdk` → `0.1.6`.

**A process note worth more than the feature.** Three gate runs failed with
32, 82 and 107 files red and ZERO assertion failures, all reporting
`template database "gl3_tmpl_..." does not exist`. Nothing was wrong with the
code: backgrounding a suite with `(… &)` and then starting another overlapped
two runs, and a second run's `dropStaleTemplates` removed the template the
first was still cloning from. It left 168 orphaned `gl3_test_*` clones behind.
The fix was to kill the strays, drop the clones and run ONE suite. This is the
third recorded instance of overlapping runs looking exactly like a regression —
`pgrep -fa vitest` and a `pg_database` count before a gate run are cheaper than
the diagnosis.

Gate: bare `npm run verify`, **207 files / 1637 passed, 1 skipped, exit 0**.
The skip is the S3 half of `asset-driver-contract.test.ts` — the same cases run
against the filesystem driver always and against a real endpoint when
`S3_TEST_ENDPOINT` is exported, which is the honest mitigation for the suite
never touching the production backend.

The repo's own `.npmrc` maps only `@gl3-plugins`, deliberately not `@gl3`: the
core packages resolve through the npm workspace here, and pointing the scope at
the registry risks `npm ci` in the image preferring a registry fetch over the
workspace link. A *plugin author's* `.npmrc` does need
`@gl3:registry=https://npm.gl3.dev`, which is what the SDK README documents.

### Hospital self-admission and local facility rosters

Shipped on `feat/hospital-jail-social`. V2's hospital and jail were each only
ever a status one player checked on themselves; this cluster makes both a
*place* — a caller sees who else is serving time in their own town and can
act on them — and gives hospital its first **voluntary** door.

- **`POST /api/hospital/checkin` is the first route that ever sends a player
  to hospital by their own choice.** Every existing path in is involuntary
  (a lost fight, a weapon backfire), so a player sitting at low health with
  nothing else going for them had no way back to full except getting killed
  first. Check-in is free — the stay is the price:
  `seconds = (maxHealth − health) × hospital.checkin_seconds_per_hp`, written
  through the existing `sendToHospital`. 409 `already_hospitalised` and 409
  `not_injured` (at full health, a zero-length stay would otherwise be a way
  to write `health = 0` and settle straight back out) bound it. It is
  reachable while jailed, deliberately — the two sentences are independent,
  neither shortens the other, matching how `discharge` already behaved — and
  it publishes nothing itself, since the player did this to themselves and
  already holds the response; the existing `player.discharged` still fires
  when the stay ends on its own. A player can check in and then immediately
  buy out through the pre-existing `discharge` route; that costs strictly
  more than waiting and is intended, not a hole.
- **Rosters are location-scoped reads that settle nothing.**
  `listSentencedAtLocation` (`apps/server/src/game/roster.ts`) filters
  `location_id = caller's` and `until > now()`, excludes the caller, and takes
  no lock at all — it is a plain `SELECT`. An elapsed sentence is simply
  filtered out by the `> now()` predicate rather than cleared; the sweeper and
  the sentenced player's own next request are what actually settle it. This is
  deliberate, not an oversight: calling `settleHospital` per row to keep the
  list "clean" would mean a roster **read** taking write locks on strangers
  the caller never interacted with, which is exactly the kind of surprise
  lock the rest of this codebase goes out of its way to avoid. A caller
  standing nowhere (`location_id IS NULL`, true of a fresh account before its
  first travel) gets `[]`, not an error. `GET /api/hospital/local` and
  `GET /api/jail/local` are thin wrappers that each price their own facility's
  roster row (`dischargeCost`, `bailCost`) at the same per-second rate the
  caller's own action would use.
- **The three two-player routes — `discharge-player`, `bail`, `bust` — add no
  new edge to the lock graph.** Each opens with exactly one sorted
  `lockPlayersForUpdate(tx, [callerId, targetId])` as its first statement,
  before either row is read. That is combat's helper and combat's ordering
  verbatim, so the player↔player pair (rule 6) already existed in the graph;
  this cluster is simply its second and third consumers after combat itself.
  The lock is not decorative: `test/facility-concurrency.test.ts` fires two
  concurrent bails (and two concurrent paid discharges) of the same target and
  asserts exactly one 200, one 409 `not_jailed`/`not_hospitalised`, and
  exactly one ledger row — then was shown red, once per route, with that
  route's leading `lockPlayersForUpdate` call removed, reproducing the same
  double-charge shape `test/hospital-concurrency.test.ts` already covers for
  single-player `discharge` (two concurrent discharges both reading
  "hospitalised" outside any lock, both charging — the ledger stays internally
  consistent throughout, so `sum(ledger) == balance` never notices). Location
  is checked against the locked rows, never locked itself — no route here
  mutates a location row, and locking one would open a location→player edge
  that every locations-first cluster (bullets, theft, properties, casino)
  would then need ordering against for no gain. `bust`'s failure branch calls
  `sendToJail(tx, callerId, …)`, which re-takes `lockPlayersForUpdate` on the
  caller alone — already held by this transaction, so it is a no-op, the same
  shape the crime worker relies on.
- **No new `GameEvent` variant — deliberate, and it avoids all four places one
  costs.** A new variant means touching `apps/web/lib/eventCopy.ts` and
  `apps/web/ws/invalidation.ts` (both fail loudly, TS2366), the `CORPUS` drift
  guard in `test/plugin-ctx-core-events.test.ts` (fails only under the
  integration suite), and the hardcoded census in
  `packages/shared/test/events.test.ts` (a *separate* list, in the
  `@gl3/shared` project, so `npm run typecheck` alone would never catch a miss
  there). Every fact this cluster produces was already expressible: bail and
  a successful bust publish `player.released` to the freed target; paid
  discharge publishes `player.discharged` to the healed patient; a failed
  bust publishes `player.jailed` (`reason: "bust.failed"`) to the caller who
  gets jailed by their own failure; and "someone paid you out" is a
  `notification.created` row inserted inside the transaction via
  `insertNotification`, whose event follows the commit with `actorId` set to
  the **recipient**, the convention `plugins/ctx.ts` documents and
  `awaitOwnEvent` depends on. All four publishes happen strictly after
  commit (rule 5), never inside `db.transaction(...)`.
- **Four settings**, admin-edited free text, parsed through the same
  defensive fallback `dischargeCostPerSecond` already used — blank or
  malformed falls back to the default rather than throwing on every request,
  and a negative value is malformed:

  | Key | Default | Meaning |
  |---|---|---|
  | `hospital.checkin_seconds_per_hp` | `30` | Stay length per missing HP |
  | `jail.bail_cost_per_second` | `1000` | Cash per remaining second of sentence |
  | `jail.bust_success_percent` | `25` | Clamped to 0–100, not defaulted — an admin who sets 0 or 100 meant it |
  | `jail.bust_fail_jail_seconds` | `300` | The caller's own sentence on a failed bust |

  `bust`'s roll goes through the repo's one RNG (`bustSucceeds(seed, percent)`
  in `apps/server/src/game/jail/bust.ts`, pure and unit-tested over fixed
  seeds including the 0/100 boundaries) seeded per request from `newSeed()`
  and never accepted from the client — a client-chosen seed is a
  client-chosen outcome. `registerJailRoutes` and `registerHospitalRoutes`
  both gained a `settings` parameter for this; like every other settings
  consumer, a change needs a server restart to take effect.
- **No migration.** No new table, column or index — the roster query is
  served by the existing `player_stats_location_idx` plus the partial
  `player_stats_hospital_until_idx` / `player_stats_jailed_until_idx`, so
  `apps/server/test/schema.test.ts`'s FK and index counts are untouched by
  this branch, and `apps/migrate` needed no new migrator: V2 stores no state
  here that is not already imported.
- **`@gl3/shared` → `0.1.12`**, additive (the roster row schema, the check-in
  response, the bail/bust response DTOs). This branch's DTO task originally
  drafted `0.1.10`, but by the time it went to publish the registry already
  served `0.1.10` *and* `0.1.11` — both taken by another session's work
  landing concurrently, so neither number belongs to this cluster.
  `0.1.12` was confirmed free (`npm view @gl3/shared versions --json
  --registry https://npm.gl3.dev`) before landing on it. **Not yet
  published** — publishing to `npm.gl3.dev` needs the user's explicit
  approval, as every previous bump did; the registry still serves through
  `0.1.11`. `@gl3/plugin-sdk` needed no bump — nothing on the manifest or the ctx changed, because the
  release-another-player primitive stayed in core rather than becoming a
  second unrestricted lever on the plugin trust surface (`publishCore` is
  already one; see design §2).
- **Gating is deliberately asymmetric.** A JAILED caller may bail others but
  not bust them out (`bust` refuses with 409 `already_jailed`, checked against
  the caller's own locked row); a HOSPITALISED caller may do all three
  (discharge, discharge-player, bail/bust). None of the new routes is gated by
  `accessInJail` / `accessInHospital` — that field exists only on **plugin**
  routes (`pluginRoute.accessInJail`/`accessInHospital` in
  `plugins/routes.ts`), and every route in this cluster is core, not plugin.
  This matches the spec and is easy to re-derive wrong from the code alone.

Gate: bare `npm run verify`, **214 files / 1676 passed, 1 skipped, exit 0**.

### Location combat modes — V2-style underground towns, per town

Shipped on `feat/location-combat-modes`. GL3 combat has shipped walk-up since
PvP landed: `GET /api/combat/targets` lists everyone in the caller's town and
an attack needs nothing but same-location, bullets and a cooldown. V2 was the
opposite — nobody in town was visible or shootable without a paid, successful,
unexpired detective report — and the detectives port (2026-08-12) reconciled
the two by making detectives the cross-location hunting layer and leaving
same-location combat free, uniformly, for every town. This cluster makes that
a **per-town choice** instead of a global one: a location is `'open'` (combat
exactly as already shipped) or `'underground'` (V2's rule, reintroduced).

- **Core migration `0013_location_combat_mode.sql`** adds
  `locations.combat_mode text NOT NULL DEFAULT 'open' CHECK (combat_mode IN
  ('open', 'underground'))`. No FK, no index — the column is only ever read
  off a row already fetched by PK, so `schema.test.ts`'s FK and index counts
  are untouched; the file gained one assertion on the new column's type
  instead. The default preserves shipped behaviour exactly: a fresh install
  changes nothing until an admin flips a town.
- **Combat gained a read-only dependency on detectives — the fifth
  plugin→plugin edge**, after combat→inventory, bounties→combat,
  bullets→properties and bullets→travel. The detectives spec (2026-08-12,
  §0/§6) had explicitly decided against any combat coupling; this revises
  that in one direction only. Detectives' worker, routes and events are
  untouched — it still knows nothing about combat.
- **Detectives plugin migration `0002_report_expiry`** adds a nullable
  `p_detectives_searches.expires_at timestamptz`. Written at hire as
  `ends_at + detectiveExpire` (the setting as read at hire time — a
  settings snapshot). This has to be a column, not a read-time computation,
  because the expire setting lives under detectives' own settings namespace
  and `ctx.settings` prepends the *calling* plugin's id — a combat-side
  reader cannot reach it. NULL `expires_at` (pre-upgrade rows only) is
  treated as expired by the new helper (`expires_at > now` is false for
  NULL, at no extra cost) and as `ends_at + detectiveExpire` by detectives'
  own tracker route, which was switched to read the column for new rows so
  the two read paths cannot diverge — pinned by a test in
  `apps/server/test/detectives.test.ts`.
- **`activeReportTargetIds(tx, hirerId, now)`**, exported from detectives'
  manifest module: one SELECT (`player_id = hirerId AND succeeded = true AND
  ends_at <= now AND expires_at > now`), read-only, no lock taken. Combat
  calls it with a `Set` membership check rather than adding a second,
  single-target helper.
- **`POST /api/combat/attack/:targetId`**: after the existing checks through
  `protected`, an underground town's `combat_mode` is read (plain SELECT)
  and, if set, the caller's active-report set gates the shot — 409
  `no_detective_report` unless the target is in it. Placed *after*
  `same_gang`/`protected` deliberately, so the error a gangmate or a
  protected newbie sees is identical in both town modes; town mode must
  never leak through error-ordering differences. The cooldown is already
  claimed before the transaction opens and stays burned on this 409, same as
  every other 4xx combat already returns.
- **`GET /api/combat/targets`** now returns `{ mode, targets }`. In an
  underground town, the caller's report set feeds a `WHERE player_id IN
  (...)` predicate on the target query **before the `LIMIT 50`, not applied
  to the 50 rows afterwards** — a post-limit filter would hide a legally
  attackable reported player who happens to rank below the 50th resident by
  exp, which is exactly the never-spend-a-cooldown-to-learn-a-rule guarantee
  the route exists for. `test/location-combat-modes.test.ts` proves this with
  51 unreported bystanders outranking one reported target. An empty report
  set skips the query and returns no rows; filtered players are absent, not
  reasoned, matching how `target_elsewhere` already behaves. The route stays
  advisory only — attack re-checks everything under the lock.
- **Reports are not consumed on a shot — time expiry only, a deliberate
  deviation from V2**, which expired a report on the first shot regardless of
  outcome. V2's fights were one report, one usually-lethal volley; GL3 combat
  is multi-shot whittling, so per-shot consumption would price a kill at
  `cost × shots`. The expiry window is the licence instead, and it keeps
  detectives' table write-free from a combat call.
- **Hospital and jail rosters stay visible in every mode**, unchanged — V2's
  own only in-town leak (getting hurt or jailed in a hideout town broadcasts
  you), kept as counterplay rather than closed.
- **`travel` changes**: `LocationListing` and the travel board gain
  `combatMode`; subscribers to `travel.locationsListed` (bullets) are
  unaffected since the interface only grew. The admin towns section gained
  the field as a `select`, validated handler-level rather than through
  `z.enum` — the loader answers a zod parse failure with the generic
  `invalid_request` before a plugin handler ever runs, so the spec's 400
  `invalid_combat_mode` needed its own check. A new
  `GET /api/admin/travel/combat-modes` feeds that select's `optionsSource`.
- **`apps/migrate` gained `--town-combat-mode`** (default `open`), threaded
  cli-args → orchestrator → `migrateLocations`'s fourth parameter, for
  operators whose players expect V2 rules everywhere on day one; per-town
  flips happen in admin afterwards.
- **Web**: `/combat`'s underground empty state ("Nobody shows their face in
  this town. Hire a detective.") links `/detectives`; `/travel`'s board rows
  carry an `· underground` tag so the strategic choice is visible before
  paying the fare.
- **No new `GameEvent` variant, no new lock-graph edge, and deliberately no
  lock-order test.** Every new read this cluster adds — the location's
  `combat_mode`, the report set — is a plain SELECT; no new INSERT reaches
  either table with a lock-taking FK. A lock-order test here would prove only
  the already-safe case (CLAUDE.md rule 6's corollary), so the audit is
  recorded instead: nobody should add one for an edge that doesn't exist.
- **Operational constraint, recorded rather than guarded against**: setting a
  town to `underground` on a deployment that never loaded `detectives` fails
  every attack and target-list read there — `p_detectives_searches` simply
  isn't there. The default `'open'` makes this opt-in. Admin-side validation
  that `detectives` is loaded stays out of scope: travel, which owns the
  admin page, has no view of the loader's installed-plugin list.
- **Deliberate non-changes**: rosters visible in all modes (above); a report
  is never consumed by a shot (above); no third `ghost` mode (wants a
  shop-price differential between town modes shipped first, so the trade-off
  exists); no admin check that `detectives` is loaded.
- **`@gl3/shared` → `0.1.13`**, additive (`CombatModeSchema`; `mode` on the
  targets response; `combatMode` on the location DTO). **Published** with
  the user's approval after the registry check the prior bumps mandated —
  the registry served through `0.1.12` at publish time (the hospital
  cluster's number had landed via another session), so `0.1.13` went out
  clean and `npm.gl3.dev` now serves `0.1.1` through `0.1.13`.
  `@gl3/plugin-sdk` needed no bump.

Gate: bare `npm run verify` on `362803a`, **217 files / 1733 passed, 1
skipped, exit 0** (third run; run 2 hit the known casino-lock-order flake
documented in CLAUDE.md, now on its third recorded occurrence).

### Jail self-escape — V2's "Escape" restored

Shipped on `feat/jail-escape`. V2's jail template offered ONE action,
`action=breakout&id={id}`, relabelled "Escape" on your own row — self-target
was legal (`jail.inc.php` names the target "yourself") and a failure added
**+90s to the existing timer**. GL3's `bust` refuses `self_target`, so the
mechanic was silently lost in the hospital-jail-social port. Restored as its
own route rather than by relaxing bust's guard, because the guards conflict
(bust 409s a jailed caller; being jailed is escape's precondition):

- **`POST /api/jail/escape`** — no body, free, no cooldown. Same
  `bustSucceeds` roll and the same `jail.bust_success_percent` as bust.
  Success clears `jailedUntil` and publishes `player.released` to self;
  failure **extends** the sentence to `existing + jail.escape_fail_extra_seconds`
  (default 90, `parsePositiveInt` so `"0"` falls back — a zero penalty would
  make escape a free reroll forever) and publishes `player.jailed` with
  `reason: "escape.failed"`. `sendToJail` is deliberately not used on the
  failure branch: it overwrites from now, which is bust's fresh-sentence
  semantics, not V2's extension. `test/jail-escape.test.ts` proves the
  distinction with an exact-ms assertion (`before + 120_000`).
- **No shared bump, no new event variant, no new lock edge.** The response
  reuses the `BustResponse` shape (`{ success, jailedUntil }` — the doc
  comment's "caller's new sentence" reading holds verbatim); both events
  already existed, so none of the four variant-census sites moved; the
  transaction opens with `lockPlayersForUpdate` on the caller alone, an
  existing pattern.
- Web: `useEscape` mutation and an Escape button in the jailed branch of
  `Jail.tsx`, with the fail-warning copy mirroring bust's.

Gate: bare `npm run verify` on `faa3102`'s tree, **218 files / 1736 passed,
1 skipped, exit 0** — after a voided first attempt that overlapped another
session's `verify:related` (caught by the user, both runs discarded, re-run
after cross-session coordination; the casino-lock-order flake did not recur).
### Social — email verification, presence, and the forum

Shipped on `worktree-social-cluster`, commits `8ef1b49..9f9ceb6`, 16 tasks
plus this one. Three SPEC §1 gaps V2 had and GL3 never ported close in one
cluster: email verification, presence (who's online), and the forum. The
shared surface widened enough to need its own version
(`@gl3/shared` → `0.1.14`), and the plugin SDK gained its first-ever
route-level query-string support (`@gl3/plugin-sdk` → `0.1.7`). **Neither is
published** — see the version note near the end of this section.

**Email verification is a hard gate, and grandfathering is total.** Core
migration `0014_email_verified.sql` adds `players.email_verified_at`
(nullable) and, in the same migration, backfills every existing row to
`now()` — nobody already playing is ever asked to verify. Registration now
requires an email (`RegisterRequestSchema.email` is
`noNulByte(z.string().email().max(254))`, closing the NUL-guard watch item
below); a new player inserts `email_verified_at: NULL`, and
`POST /api/auth/register` sends the verification email only after the
transaction commits (rule 5). The gate itself is one Redis flag, not a
per-request DB read: `markUnverified` sets `unverified:<id>` (no TTL) when a
new player registers, `requireAuth` answers 403 `email_unverified` for a
flagged player on any non-exempt route, and `clearUnverified` fires on
successful verification. **Login re-asserts the flag from the `players` row
every time**, so a Redis flush self-heals on the player's next login instead
of silently unlocking an unverified account forever. Verification tokens are
12-character Crockford-base32 codes (unambiguous when typed back out of an
email), stored as `emailverify:<code>` with a 24-hour TTL and consumed by
`GETDEL` (rule 2) — a wrong code deletes nothing, a right one redeems
exactly once; resend is capped at 3/hour through the existing `tokenBucket`.
`GATE_EXEMPT` (`/api/auth/verify`, `/api/auth/logout`, `/api/auth/me`) is
the only carve-out — everything else, core routes and plugin routes alike,
403s for a flagged player, because `registerPluginRoutes` runs every plugin
route through the same `app.requireAuth` decorator core uses.

**`requireAuth` became the one choke point for the gate and for presence in
the same commit.** Every authenticated request, core or plugin, calls
`touchPresence` before the unverified check runs, so both facts land off one
decorator with no per-route wiring anywhere else.

**Password reset reuses the token shape.** `POST /api/auth/forgot` always
answers 200 whether or not the email exists (anti-enumeration) and only
actually mails a *verified* account; `pwreset:<token>` is a 32-byte-random
token, 1-hour TTL, `GETDEL`-consumed, same as verification. A successful
reset kills every session on the account, not only the one that reset it —
`playersessions:<playerId>`, a new Redis SET, is a reverse index of every
live session token (`createSession` SADDs the new token in,
`destroySession` GETDELs the session key then SREMs it out, and the new
`destroyAllSessions` reads the whole SET and deletes every member key plus
the SET itself).

**Presence.** `touchPresence` (`apps/server/src/presence/touch.ts`) runs on
every authenticated request: an unconditional `ZADD presence <now> <id>`,
plus a throttled write to `players.last_seen_at` — the V2 column GL3 had
carried but never written — gated by `SET lastseenmark:<id> 1 EX 60 NX`,
where the `NX` outcome *is* the decision (rule 2) so concurrent requests
need no read to agree on who does the write. `GET /api/online` trims the
ZSET lazily (`ZREMRANGEBYSCORE presence -inf now-1h`, no cron — the same
settle-at-read shape `ensureCurrentRound` established) and returns two
windows, `onlineNow` (active in the last 5 minutes) and `lastHour`, built
off one `inArray`-batched hydration joining `players` → `player_stats` →
`locations`. An underground town's residents keep their name and recency in
the listing — only `locationName` comes back `null`, the same concealment
rule location combat modes established for combat and travel. Profile
gained `lastSeenAt`, and the public profile route gained a `tokenBucket`
(60/60s), closing the "unauthenticated and un-rate-limited" watch item
below.

**The test-suite migration was this cluster's largest mechanical cost.**
Requiring a verified email broke registration for roughly 90 existing test
files that logged a player in over the plain HTTP flow.
`registerVerifiedPlayer` — a new test helper that registers for real, scans
Redis for the `emailverify:*` code by player id, and calls
`POST /api/auth/verify` — was adopted across all of them rather than any
test-only bypass, so the suite still exercises the real gate end to end. The
rate-limit-isolation sweep gained buckets for
`verify`/`verifyresend`/`forgot`/`reset`; zod's `.email()` rejects a digit
top-level domain, so every fixture generating an address switched to an
`example.test`-style domain; and two subscribe-mode Redis clients
(combat's backfire test, theft's chase test) needed a second, ordinary
client alongside the one already in subscribe mode, since the new
verification-email lookup needs an ordinary `GET`/`SCAN`-capable connection.
**The full suite now runs ~525s**, up noticeably from the low-300s range the
tree had settled at since the `resetDb` batched-`TRUNCATE` fix (CLAUDE.md) —
almost entirely the cost of one extra register-then-verify round trip per
file that logs a player in.

**Forum** (`@gl3/plugin-forum`) is the **nineteenth plugin and the ninth to
own tables and migrations** — `p_forum_forums` / `p_forum_topics` /
`p_forum_posts`, one `CREATE TABLE`/`CREATE INDEX` statement per migration
entry, the same postgres.js `unsafe()`-rejects-multi-statement constraint
bounties' migrations already documented. Foreign keys cascade a forum's
deletion down through its topics and posts, and `SET NULL` a deleted
author out of their own content rather than deleting it. **No forum route
takes an explicit lock anywhere**: a reply advances `last_post_at` /
`post_count` with a plain self-serializing
`UPDATE ... SET post_count = post_count + 1`, and the only locking the FKs
impose (`FOR KEY SHARE` on the parent forum/topic and, when set, on
`players`) has no second lock in the same transaction to invert against —
so this cluster adds **no new lock-graph edge, and deliberately no
lock-order test**. Reads are paginated 20/page, sticky topics first then
most-recently-posted, off one indexed `ORDER BY`
(`p_forum_topics_listing_idx` on `(forum_id, type, last_post_at DESC)`) — no
N+1. Writes go through `ctx.cooldown` — the same SDK surface combat's shot
cooldown already uses, not new SDK surface — 60s between topics and 15s
between posts, V2's own numbers. A reply notifies the topic's author via
`tx.notify` unless the author is the replier or the topic is a migrated V2
row with no author at all. Moderation is `hasPermission("forum")`: an ABAC
grant doubles as forum moderator and, by the existing shape of
`role_module_access`, also passes the `/api/admin/forum` loader tier —
consistent with every other module grant, noted rather than special-cased.
Admin CRUD is `adminPages`, with no UUID column displayed anywhere
(`admin-ids-hidden`'s floor moves 10 → 12 to cover it), and the
rename/reorder route is `POST /api/admin/forum/forums/update` with the
target id in the request body rather than the path, because an `adminPages`
form's `action` has to be a static string — the same shape travel's
`/locations/update` already established. Web pages `Forum.tsx` /
`ForumTopic.tsx` follow Mail's list/detail structure and Crimes' countdown
idiom for the cooldown, with client-side quote prefill.

**M4 gained a ninth migration phase, after social, just for forum
content.** `migrateForum` needs players already resolved in `id_map` for
author lookups, and nothing later in the pipeline reads a forum table, so it
did not need a slot inside the social phase — one more `runPhase` call in
`orchestrator.ts`. V2's gang forums (`F_id < 0` by convention) are
reported-skipped wholesale, and every topic or post filed under one cascades
to skipped for the same reason — V2 enforces no foreign keys, so a topic or
post referencing a forum this run never saw is indistinguishable from one
under a gang forum and is treated the same way. V2's `T_type` bitmask
(sticky | important) collapses onto GL3's two-value `CHECK`: either bit set
becomes `'sticky'`. V2 kept no `post_count`/`last_post_at` columns at all,
so both are recomputed from the migrated posts in one aggregate `UPDATE`
after every post is in, never trusted from source. All three inserts are
idempotent upserts keyed on the `id_map`-resolved UUIDv7, so a re-run is a
no-op. `mysql/fingerprint.ts`'s `KNOWN_TABLES` gained `forums`/`topics`/
`posts`, and `orchestrator-idempotency.test.ts`'s three-run
identical-count proof grew from 26 to 29 target tables.

**No new `GameEvent` variant anywhere in this cluster, and no new explicit
lock-graph edge anywhere in this cluster.** Forum's reasoning is above;
email verification, password reset and presence publish nothing beyond the
existing `notification.created` where they publish at all, and none of the
three touches a row two other paths don't already lock the same way.

**`@gl3/shared` → `0.1.14`** — the required-email + NUL guard on
`RegisterRequestSchema`, `VerifyRequestSchema` / `ForgotRequestSchema` /
`ResetRequestSchema`, `dto/online.ts`, `dto/forum.ts`, `targetPlayerId` /
`placerPlayerId` on the bounty row DTO, and `lastSeenAt` on `ProfileDto` —
additive, **since published** (`0.1.14` reached the registry from another
session; `0.1.15` followed with the money-units cluster below), same
registry-check-first caveat as every prior bump. **`@gl3/plugin-sdk` → `0.1.7`**, its first-ever route-level
query-string support: an optional `query` zod field on `route()`, defaulted
to `z.unknown()` the same way `params`/`body` already default, parsed by the
loader with a clean 400 on a malformed query string — neither the forum
plan nor its design anticipated `?page=`, and this is the SDK gap that
closed it. **Also since published** (`0.1.7`, then `0.1.8` with the
money-units cluster below).

Gate: bare `npm run verify` on `9f9ceb6`, **228 files / 1804 passed, 1
skipped, exit 0**, no unhandled rejections, no `(0 test)` cross-talk (the two
`.test-d.ts` typecheck-only files are the same expected pair prior gates
recorded), and the known `casino-lock-order` flake did not fire this run
(clean 5/5). Duration 711.5s, up from 217/1733's run — almost entirely the
email round-trip cost described above.

### Properties inline — the /properties tab retired

Branch `feat/properties-inline`. Pure web relocation, no server gameplay
change: the hand-written `/properties` page moved into
`apps/web/src/components/PropertyPanel.tsx`, embedded on each declaring
plugin's own page — the bullets page shows the town's factory (it previously
showed no owner at all), the casino lobby shows each game's table under the
games list. Owner line always; Buy when unowned and the type is installed;
the full owner tools (lever, P&L, Transfer, two-step Drop with half-price
refund, Reset) when yours. `rowAction`/`dropRefundOf` moved with their tests
(`test/property-panel.test.ts`, replacing `properties-page.test.ts`) plus a
new `rowsFor` filter. Deleted: `Properties.tsx`, its App route, the nav tab,
the `/properties` banner-map entry, and core's `page-properties` singleton
asset slot (orphaned bindings are the sweeper's job, by design). API
untouched — `GET /api/properties` still serves the caller's town and each
panel filters by its `pluginId`. Rule recorded in the franchise design doc's
amendment: a plugin declaring a property type via `providesProperties` must
surface owner/buy on its own page, since there is no fallback tab any more.
The management routes were never location-gated, but the old tab only ever
listed the caller's town, so nothing a player could do was lost.

### Admin deletion — per-row delete with in-page confirm, everywhere

Branch `worktree-feat-admin-delete`. The view vocabulary's `table` leaf gained
an optional `rowActions` array (`{ label, action, confirm? }`) in BOTH copies —
`packages/plugin-sdk/src/pages.ts` and `packages/shared/src/dto/plugins.ts`,
the parity the `cards` leaf broke once already; `view-node-parity.test.ts` now
also parses a rowActions-bearing node through both schemas, since the kind-set
check cannot see a property that exists in one copy only. Every `:token` in an
action's path is substituted by the renderer from the row's own fields (`:id`
mostly; `:locationId/:itemId` for shop stock's composite key), and `confirm`
makes the button a two-step arm-then-fire in place — the property board's
shape, never `window.confirm`. The loader's containment pass collects row
actions like any button action (`admin-validate.test.ts`).

Delete routes, all `auth: "admin"` (or core's inline grant check), each with
its own semantics — the FK graph decided them:

- **travel towns** — refused while occupied (`location_in_use`, 409):
  `player_stats.location_id` is SET NULL and would strand players silently; a
  plugin-table FK (deed, garaged car) surfaces as the same 409 via 23503.
- **inventory items** — refused while owned or equipped (`item_in_use`):
  `player_items` CASCADEs and the equip columns SET NULL. Deleting also
  removes the item's `p_inventory_shop_stock` rows explicitly — that table
  has no FKs, so orphans are the route's job. **Shop listings** delete by
  composite key (`DELETE .../shop/:locationId/:itemId`).
- **theft cars** — refused while garaged (`car_in_use`); **tiers** delete
  plainly (nothing references a tier).
- **crimes** — plain delete; `crime_log` and `player_crime_skill` CASCADE
  (history about the crime goes with it), and a queued worker attempt fails
  closed on the missing FK.
- **ranks** — plain delete even while held: `rank_id` SET NULL self-heals at
  the next exp change and every reader left-joins. **Money ranks** likewise.
- **news, forum** — plain deletes; a forum takes its topics and posts
  (declared in the confirm text).
- **properties** — refused while owned (`property_owned`); an unowned row is
  config. One-row FOR UPDATE, no second lock.
- **core roles** — refused for the caller's own role
  (`cannot_delete_own_role`, the revoke guard's harder sibling) and while any
  player holds it (`role_in_use`); grants cascade.
- **core rounds** — only `scheduled` deletes (`round_not_scheduled` 409),
  under the ROUNDS_LOCK advisory lock so a delete can never interleave with a
  rollover; active/ended rounds are owed a settle and a finalized round IS
  the hall of fame (`round_entries` cascade).
- **bullets** (per-location config rows) and **casino** (open hands are
  read-only by design — settling needs locks only a player's own `play`
  holds) deliberately gained no delete.

No new lock-graph edge: every delete is a single-row operation (plus
same-table cleanup) behind at most one FOR UPDATE. Also fixed in passing:
forum's admin table feed returned `sort` as a JSON number, which fails
`TableRowsResponseSchema`'s all-string parse inside TableBlock and blanked
the whole table client-side. `@gl3/shared` → `0.1.15`, `@gl3/plugin-sdk` →
`0.1.8` (additive; both **since published** — see the money-units section
below).

### Money units are whole dollars — the 100× cents bug

Branch `fix/money-units-dollars`, merged to `main` (`1b093dd`). The
properties-franchise design doc invented an "in cents" convention
(`docs/superpowers/specs/2026-08-15-properties-design.md` onward) that no
layer ever implemented: the M4 migrator copies `US_money`/`PR_cost`/
`L_bulletCost` **verbatim**, `seed.ts` is dollar-scale, and
`apps/web/src/lib/money.ts` formats without dividing — GL3 money bigints are
V2's own unit, whole dollars. Every figure derived from the comment charged
100×: bullets' and blackjack's `providesProperties` price (`100_000_000n` →
`1_000_000n`, V2's $1,000,000), properties' `LEVER_FLOOR` (`10_000n` →
`100n`, V2's $100 floor), casino's `DEFAULT_MIN_BET`/`DEFAULT_MAX_BET`
(`10_000n`/`10_000_000n` → `100n`/`100_000n`). On migrated data the old
values were not just expensive but wrong-shaped: a migrated house lever
(dollars) sat *below* the min bet, making tables unplayable, and legal V2
levers sat below the floor and could never be re-set. Twelve test files
restated expectations — two of them (`casino-play`'s `"5000"` wager,
`properties-events`' `"100000000"` price) were **string** literals a bigint
grep missed, and surfaced only in the full gate run. The stale "cents"
wording in the 2026-08 design docs is left as a historical record; the
convention is now pinned in the SDK's `providesProperties.price` docblock.
With this branch's commit, `@gl3/shared@0.1.15` and `@gl3/plugin-sdk@0.1.8`
were **published** with the user's approval — `npm.gl3.dev` now serves
shared `0.1.1`–`0.1.15` and the SDK `0.1.0`–`0.1.8`.

### Admin section tabs wrap

Same branch (`c8572fc`): `pages.module.css`'s `.tabs` row never declared
`flex-wrap`, so once the admin grew past ~10 sections the row overflowed the
content column and the sticky event feed — an opaque panel, later in the
DOM — painted over the overflow, leaving the right end of the section menu
unreadable. One line (`flex-wrap: wrap`), matching what `.nav` always did;
Leaderboards shares the class and inherits the safety.

### Detectives admin and V2 duration-unit parity

Same branch (`dc2b619`). V2's "hours" dropdown is really a **unit count**:
`detectiveDuration` (default `1` in shipped V2 — operators used it for
fast timings; `3600` makes units real hours) says how many real seconds one
unit lasts, and cost and success odds are per *unit*, not per real second.
GL3 already read `detectives.duration` but had no admin for it and the page
hard-labelled the dropdown "Hours". Three changes: an `adminPages` panel
plus `GET/POST /api/admin/detectives/settings` (cost, duration, expire —
bullets' options-panel pattern: reads and writes the settings TABLE, edits
take effect on the next restart, and the panel says so); `durationSeconds`
on the list DTO (rode `@gl3/shared@0.1.15`) so the web dropdown labels its
1–5 options from the real span ("1 hour" at 3600, "1 second" at 1 — V2 fed
`i × detectiveDuration` through `timeElapsedString()` the same way), with
the wire field still named `hours` (published shape, V2's own name); and
three new `migrateSettings` renames — `detectiveCost`/`detectiveDuration`/
`detectiveExpire` → `detectives.cost/duration/expire` — so a migrated
operator's tuning no longer reverts silently to the coded defaults (the
exact failure the rename map exists to prevent; the map is now nine keys).
No new lock-graph edge, no migration, no new `GameEvent` variant. New test
file `admin-detectives.test.ts` is registered in `vitest.workspace.ts` (the
ninth-site trap). Merge gate: bare `npm run verify` exit 0 from the
process, 231 files / 1873 passed.

### Premium membership — timed status, benefit registry, gifting

V2's `membership` module, ported and improved, on `feat/membership`.
`@gl3/plugin-membership` is the **20th plugin and the 10th to own tables and
migrations**. It owns `p_membership_packages` (plugin migration `0001`:
`id`, `name`, `cost_points`, `duration_seconds`) with **no foreign keys** —
like `p_inventory_shop_stock`, it adds no lock-graph edge, so there is no new
lock-order test, no core migration at all, and `schema.test.ts`'s FK/index
counts are untouched. Membership *status*, deliberately, is not a plugin
table: it is the core `player_timers` row keyed `membership`, which M4 has
migrated verbatim from V2 `userTimers` since M4 shipped — this cluster is
the money-ranks pattern again, making an already-migrated-but-unread table
live rather than moving any data.

The SDK gains generic per-player timers, `tx.timers` (`get`/`set`/`clear`
over `player_timers`), mirroring V2's own open-ended `userTimers` key space
so a future plugin can carry per-player expiries without owning a table.
`clear` returns a deleted-boolean, which is what makes the expiry path
below a once-only claim rather than a check-then-act. Buy is a plain
points sink with V2's exact stacking rule, `max(now, current expiry) +
duration` — never wasteful, extends from whichever is later. Lazy expiry
notification lives in `membershipUntil`'s DELETE-as-claim: an expired timer
row is deleted and the deletion's row-count, not a prior read, decides
whether to notify — no cron, no Redis marker, and a second concurrent
caller deletes zero rows and stays silent. Gift reuses the existing
player↔player edge — `tx.locks.player([buyer, recipient])`, sorted — rather
than adding a new one; per the CLAUDE.md rule-6 corollary, a lock-order test
here would prove only the case the shared helper already makes safe, so
none was added.

Benefits are declared through a filter point, `membership.benefits` (the
`casino.games` shape — an extension point costing no SDK surface), and are
otherwise consumer-owned: the module that owns the affected number applies
its own effect and its own display copy. Three consumers subscribe, and
each is a new plugin→plugin dependency edge — the **6th through 8th**,
after `bounties→combat`, `combat→inventory`, `bullets→properties`,
`bullets→travel` and `combat→detectives`:

- `crimes → membership` — "Getaway Driver", `cooldownSeconds = ceil(base ×
  0.75)`, applied at both `ctx.cooldown.acquire` and the listing DTO.
- `travel → membership` — "Frequent Flyer Discount", `cost = ceil(base ×
  0.25)` (computed as `(cost + 3n) / 4n` to stay in bigint), applied at
  charge, the listing DTO, and the purchase event.
- `theft → membership` — "Slide Hammer", `chance = min(100, floor(base ×
  1.1))`, applied at steal and in the tier listing.

Every consumer applies its multiplier at both the listing route and the
acting route, so the page never shows a number the action won't honor.
Events are plugin events only (`tx.events.publish`) — this cluster adds no
`GameEvent` variant, so none of the four places a new variant would touch
(`eventCopy.ts`, `ws/invalidation.ts`, the `CORPUS` guard, the shared-package
event census) needed changing, the trap the rounds cluster hit head-on.
Admin is package CRUD via `adminPages`, with a blankable rename field — no
UUID renders anywhere, so the `admin-ids-hidden` floor rises from 12 to 13
sections. `/membership` is manifest-declared (the theft precedent, not the
hand-written properties exception): status, benefits and packages tables,
a buy form, and a gift form using the existing basic text-field branch of
`ViewNodeSchema` for the recipient name — no view-vocabulary change.

M4 gained a new migrator: V2 `premiumMembership` → `p_membership_packages`
in the first content-migration phase, `id_map` UUIDv7 as usual, and
`KNOWN_TABLES` gains the target — ten plugin-owned tables now covered by the
idempotency census. Migrating this table surfaced a fixture defect, not a
migrator or spec bug: `apps/migrate`'s test fixture DDL had declared the
description column `PM_name`; real V2 names it `PM_desc`. Fixed in
`apps/migrate/test/fixtures` on this branch — the `PR_owner` defect class,
same shape as the properties-franchise column-name miss, caught this time
before shipping rather than after. V2's `membershipLinkName`/
`membershipName` settings are report-skipped by `migrateSettings` (they fed
template labels GL3's manifest-static page title has no equivalent for).

No shared-package bump: the membership views are generic manifest tables
with no shaped response DTO, so `@gl3/shared` is untouched by this cluster
(see the spec's amended "Shared DTOs and versions" section). `@gl3/plugin-sdk`
→ **`0.1.10`** for `tx.timers`, additive, **unpublished** pending the user's
approval (a registry check first — the repo's now-familiar
another-session-took-the-number risk). New test files
(`membership-plugin.test.ts`, `membership-gift.test.ts`,
`admin-membership.test.ts`, `membership-benefits.test.ts`) are registered in
`vitest.workspace.ts` (the ninth-site trap).

The `casino-lock-order` ABBA flake (`survives A-plays-at-B's-table racing
B-plays-at-A's-table` — bare 500 on `lockPlayersForUpdate`, no SQLSTATE
captured under the test logger) fired **once more** during this cluster's
scoped `verify:related` run — the fourth occurrence on record, same shape as
the three logged above, green on an immediate standalone re-run. Nothing in
this cluster's diff touches casino or the lock helpers; recorded here as
further evidence the failure is load-dependent rather than tied to any one
branch's changes.

### Blackjack tables — multiplayer seats, a second registry, one lazy clock

Spec: `docs/superpowers/specs/2026-08-20-blackjack-tables-design.md`. Plan:
`docs/superpowers/plans/2026-08-20-blackjack-tables.md`. Branch
`feat/blackjack-tables`. The casino-and-blackjack cluster shipped a house that
could only ever seat one player against the dealer; this cluster gives it a
shared table, and blackjack moves house from the solo `casino.games` registry
to a second, parallel one built for it.

**A second registry, not an extension of the first.** `TableGameDef` is not
`GameDef` widened — `start`/`act`/`settle`/`view` keep their solo shapes, but a
table game's `act` returns `{ state, wagerDelta }` against a **seat**, not a
session, and settle returns a payout per seat rather than one figure. The hub
collects them through `casino.tableGames`, a second filter point alongside
`casino.games` — `bounties → combat`'s shape, twice over. Blackjack's solo
`GameDef` is **deleted**, not deprecated: V2 never had single-player
blackjack, and the table registry is what a migrated `plugin_id = 'blackjack'`
property row now lights up against. The solo hub itself is untouched code, but
its own tests could no longer prove they still worked against real rules once
blackjack left — see the FARO conversion below.

**Two tables, no core migration.** `p_casino_tables` (migration `0003`) is the
shared row a hand lives at: `phase`, `turn_seat`, `deadline_at` and `hand_no`
are hub-owned even though `state` stays opaque game jsonb, because without a
hub-visible turn the hub could not answer 409 `not_your_turn` without decoding
a game's own state. `p_casino_seats` (`0004`) is a player's chair, with two
unique indexes: `(table_id, seat_no)` (`0005`, so a seat can't double-occupy)
and a **plain** `(player_id)` (`0006`, game-wide, no `WHERE` — a seat row is
deleted on leave rather than status-flagged, the table-flow sibling of
`p_casino_sessions_one_open`'s partial index). `seat_no`'s `CHECK (BETWEEN 0
AND 4)` is the hard five-seat ceiling. Both FKs cascade and both rows are
already held `FOR UPDATE` by every inserting transaction, so the `FOR KEY
SHARE` they take conflicts with nothing new — the by-now-familiar rule-6
non-event. No core migration, so `schema.test.ts`'s FK/index counts are
untouched by this cluster.

**The lock order — one new edge, everywhere.** Every mutating table route
(`sit`, `leave`, `bet`, `act`, and the slow-path GET) takes, in this exact
order: `tx.locks.location` on the table's town, then **one** sorted
`tx.locks.player` over every seated player plus the frozen house's owner plus
any caller not yet seated (`sit`), then the table row `FOR UPDATE` —
`lockTable` (`packages/plugins/casino/src/table-engine.ts:29`) is the single
place that order is expressed, which is what lets one test file pin all five
routes. It is not the solo hub's edge re-tested: solo `play` locks at most two
player rows, the table locks up to six, every one of which can be seated at a
*different* table in a *different* town at the same instant.
`apps/server/test/casino-table-lock-order.test.ts` proves it with a
deliberate-inversion ABBA case (A bets at B's table racing B bets at A's
table, in two different towns) that went red with a **real captured `40P01`**
— mutual `ShareLock` detail and all — because `plugins/routes.ts`'s
driver-cause `console.error` (commit `3e3e5d7`, already on `main` before this
branch, closed as T11.5 with no diff needed) finally had a flake to catch. See
the flake note below.

**The clock is lazy, not cron.** `advanceTable` re-derives, on every read or
write that touches a table, whatever a cron firing on the deadline would have
produced: deal-if-ready, stand-the-timed-out-seat, or settle, looping until
the deadline is in the future or the hand settles. Each pass is stamped with
`clockFrom` set to the deadline it just cleared rather than to "now" — spec
§5's "repeat until the clock is in the future or the hand settles" read
literally — which is what makes an abandoned three-seat hand resolve in one
read instead of needing one poll per seat to clear 30 seconds at a time. The
loop is bounded at `3 × MAX_TABLE_SEATS` (15) passes; a well-behaved game
costs at most `1 + MAX_TABLE_SEATS`, so the margin exists purely against a
rogue `autoAct` that never advances the turn. Exhaustion throws a loud
`invalid_turn` 500 rather than building refund machinery — a ruling carried
from T11 into T14: the table stays poisoned (stuck escrow, a permanent 500 on
every future read including `leave`) until an operator intervenes, which
matches the install-time trust model `publishCore` already established.
`casino-rogue-table.test.ts` is the red proof, a hostile `TableGameDef`
installed through the real filter point.

**Escrow, settle, and the sink.** A bet escrows per seat; `assertTableCanCover`
sums every live seat's exposure (`wager × game.maxPayoutMultiplier`) against
the house's own cash before covering a raise, the multi-seat generalisation of
the solo hub's `assertHouseCanCover`. `settleHand` pays every in-hand seat in
**ascending seat order** and fires the bankruptcy takeover
(`@gl3/plugin-properties`'s `takeOverFrom`, the property-board cluster's
mechanism) for the **first short-paid winner**, not the first winner overall —
a house that can cover seat 0 but not seat 1 fails at seat 1, and seat 1 is
who takes the table. `seized` is a latch: once it is set, every payout after
it comes from the sink instead of `payOwner`, because the debit that tripped
the latch was already clamped to the old owner's cash, so that owner provably
holds 0 and a later `payOwner` call on the same property would move nothing —
routing through the sink is not a shortcut, it is the only path that still
pays. Every winner is credited in full throughout; the takeover rides on top
of the money, never in place of it. **`settleHand` retains the final hand's
state** rather than clearing it — a ruling made at T16, spec §6 amended in
place: `dealIfReady`'s next deal overwrites it, but between hands the
betting-phase view shows the just-finished hand's cards rather than nothing,
which is the only way a multiplayer result is ever visible to the seats that
were in it (and to a newcomer glancing at the table, which is public
information anyway).

**The wager-0 leave escape hatch.** `leave` on a seat with `wager == 0` (not
in the current hand) bypasses the game registry and the clock entirely — a
deliberate carve-out from T11's original "leave builds a registry" rule, for
the case where a table's game plugin has since been uninstalled and no
registry can be built at all. `p_casino_seats`' game-wide `UNIQUE(player_id)`
makes leave the only way out of a seat, so this is the one path that must
never depend on the game still being installed. A seat mid-hand has no such
exit — it needs the registry to resolve `autoAct` for the clock, and is
accepted operator territory once a table goes rogue.

**The lobby polls; it does not publish.** `GET /api/casino` lists
`tableGames` alongside the existing solo games, plus remote-town seat counts
(no usernames — the same privacy stance combat and travel already take on an
underground town). The table view refreshes by polling every 2.5 seconds
rather than by event, a deliberate deviation from the rest of GL3's
event-driven invalidation: a hand can advance on its own, via the lazy clock,
with no request in flight to publish from, so there is no natural moment to
fire an event from. This cluster adds **no new `GameEvent` variant** — solo
casino already shipped with no per-hand events, for the same "one event per
hand floods the feed" reasoning, and `eventCopy.ts` / `ws/invalidation.ts`
are untouched, confirmed by diff.

**Blackjack's rules go multi-seat**, and the solo engine is retained rather
than deleted, because its EV-shaping logic (the hole card, hit/stand/double)
is exactly what a table hand still runs per seat — `dealIfReady` deals every
`wager > 0` seat, consuming the table's one stored seed and rotating it, in
one pass. `blackjack-table-rules.test.ts` covers the multi-seat mechanics
(turn order, per-seat busts, the dealer settling once against every live
hand) and `blackjack-table-view.test.ts` covers what a seat sees mid-hand —
its own cards, other seats' cards, and the dealer's hole card still hidden
until the dealer's turn, the same concealment bug the solo cluster's final
review caught, now re-proven at the table.

**The FARO conversion.** With blackjack gone from the solo registry, every
test that exercised the solo hub through real rules (`casino-play`,
`casino-act`, `casino-lobby`, `casino-lock-order`) had nothing left to run
against. `apps/server/test/helpers/faro.ts` is a small deterministic
synthetic `GameDef` — `wait` (non-settling, blackjack's `hit` stand-in),
`win`/`lose`/`push` (settling) and `double` (a `wagerDelta` raise) — installed
via its own `faroPlugin` alongside `CORE_PLUGINS` in each converted file, so
the solo hub keeps a live game to exercise even with no shipped solo game left
to test with. `casino-lock-order.test.ts`'s conversion is the one with
teeth: FARO's deterministic `start`-never-settles shape reproduces the
original ABBA choreography exactly, so the solo hub's own regression test
kept its bite. One gap FARO's original action set left open — the non-settling
branch of `act` — was covered in a follow-up commit adding `wait` before the
conversion was called done.

**Test inventory.** New files: `casino-tables.test.ts` (sit/leave/read),
`casino-table-money.test.ts` (bet/deal/act/settle escrow and payout),
`casino-table-clock.test.ts` (the lazy-advance shapes),
`casino-table-lock-order.test.ts` (the ABBA/inversion/seat-race regression),
`casino-rogue-table.test.ts` (the hostile-game red proof),
`blackjack-table-rules.test.ts`, `blackjack-table-view.test.ts`,
`packages/shared/test/casino-tables.test.ts` (the new DTOs) and
`apps/web/test/casino-table-helpers.test.ts`, plus the FARO conversions of
`casino-play`, `casino-act`, `casino-lobby` and `casino-lock-order`. All are
registered in `vitest.workspace.ts` (the ninth-site trap).

**Package versions.** `@gl3/shared` `0.1.17` → `0.1.18` for the table DTOs
(`packages/shared/src/dto/casino.ts`) — additive, **unpublished** pending the
user's approval after a registry check. `@gl3/plugin-sdk` is untouched: the
table cluster needed no new SDK surface, so it stays at `0.1.10`.

**The flake, and its first payoff.** `casino-lock-order`'s ABBA case (a bare
500 on a `FOR UPDATE` acquisition under full-suite load) has recurred four
times before this cluster with no SQLSTATE ever captured under the test
logger, despite `plugins/routes.ts` logging the driver error's `cause` since
the casino-blackjack branch — `app.ts`'s `logger: config.nodeEnv !== "test"`
made the `request.log.error` call a no-op in exactly the environment the flake
lives in. That gap closed on `main` before this branch started (commit
`3e3e5d7`, a `console.error` fallback that survives the silenced test logger,
verified as already-solved at T11.5 with no diff needed). Task 13's red proof
for `casino-table-lock-order.test.ts` is the first time that logging has ever
actually fired on a real deadlock: the deliberate inversion produced a genuine
`40P01` with mutual `ShareLock` detail in the captured output, not the bare
500 this repo has chased four times. The next time the *solo* flake fires
under a full-suite run, it should — for the first time — carry its SQLSTATE
too.

### Silent events — a feed-suppressed declaration, and the table's WS path

**The blackjack-tables cluster's one deviation from GL3's event-driven
invalidation is closed.** That cluster polled at 2.5s and published nothing,
because every plugin event renders a feed line through its `describe`
template and a blackjack hand is ~10 transitions across up to five seats.
The missing primitive was never "an event casino could publish" — it was a
declaration that says *do not render this*. `PluginEventDecl` gains
`silent?: boolean` (absent = false, schema still `.strict()`), carried by
`buildPluginsPayload` into `EventMetaSchema` and read by exactly one place on
the client: a new pure `isSilentEvent` in `apps/web/src/lib/eventCopy.ts`.

**The enforcement point is the STORE, not the renderer**, and the first cut had
this wrong. `store/events.ts` is a 50-entry ring buffer, so a silent event that
is stored and then filtered at render time still takes a slot and pushes a real
fact out the back — two hands at a full table is ~100 ticks, the whole buffer,
and the feed would read "Nothing yet" while a crime, a kill and a bounty were
evicted behind it. A silent event therefore never enters the store at all:
`recordEvent(event, metas)` is the socket's only way in, and
`ws/useGameEvents.ts` reads the manifest from cache BEFORE the store write
rather than after it. `EventFeed.tsx` filters too, for the events already in a
long-lived tab's store when a manifest first loads.
`ws/invalidation.ts` and `plugins/invalidation.ts` are **untouched, confirmed
by diff** — a silent event still invalidates precisely what it declares.
Silence is per-declaration rather than per-publish, so the trust class is
`publishCore`'s: install-time, no runtime guard, a plugin can silence only its
own lines.

**`describe` stays required.** A client whose cached manifest predates the
flag renders the template it already knows — noise, which is what the feed
did before this cluster, rather than a missing field it would have to cope
with. The loader OMITS the key when a declaration does not set it (and when
it sets it to `false`), so every payload built before the flag existed is
byte-for-byte what it was; `plugin-manifest-endpoint.test.ts`'s existing
`toEqual` on a flagless declaration is what pins that from the other side.

**Casino publishes its first event**: `table`, `silent: true`, payload
`{ tableId }`, `invalidates: ["casino"]` — one prefix that covers both the
lobby's query key and the table view's. `publishTableTick` (`table-engine.ts`)
sends one per player at the end of every mutating table transaction — sit,
leave, bet, act — and from **GET's slow path**, which is unusual and correct:
a lapsed-clock advance is a mutation the other seats must learn about, the
loader flushes only after commit, and the publish is gated on `clockLapsed`,
now shared with `advanceTable`'s own loop test rather than restated, so a
read that lost the race to another transaction and advanced nothing publishes
nothing.

**Recipients are the seat set before the change UNIONED with the set after
it**, deduped by player id, and the union is the load-bearing half. A seat
this transaction FREED — by leaving, by the idle sweep at deal time, or by a
settle that emptied and deleted the table — appears in the post-change set
nowhere, and is exactly the client still holding a `casinoTable` cache entry
nothing will correct. That is why `lockedSeat` hands `bet`/`act` a `before`
snapshot, why `leave` copies `locked.seats` before the clock runs, and why
`freeSeat` publishes to its pre-delete seat list: `advanceTable` can swap
`locked.seats` for a filtered array mid-call, so the pre-set must be copied
at `lockTable` time or the kicked seats are already gone from it.

**The poll survives, relaxed to 15s** (`TABLE_POLL_MS`). It is no longer the
realtime channel — WS invalidation is — but it is still the lazy clock's only
heartbeat: `advanceTable` runs because somebody READ the table, and a table
nobody is acting at generates no request to publish from. Unseated stays
`false`.

**`usePlugins` gained `staleTime: Infinity`**, which is a consequence of the
tick rather than a tidy-up. `pluginInvalidationKeys` prepends `keys.plugins()`
to EVERY plugin event on purpose (an unknown event is exactly when the manifest
is most likely stale), so without it each seated client would refetch the whole
manifest — every page and view tree included — several times a hand. The
payload is built once at boot and is identical for every player for the life of
the process, so marking it permanently fresh makes that invalidation harmless
without touching the invalidation rule.

This cluster adds **no migration, no lock-graph edge and no `GameEvent`
variant** — a `plugin.event` envelope is not a new variant, so none of the
four places a core variant touches is involved, and every publish sits inside
a transaction that already holds the full table lock order.
`apps/server/test/casino-table-events.test.ts` (registered in
`vitest.workspace.ts`, the ninth-site trap) covers the manifest flag through
`GET /api/plugins`, the recipient set for a bet, the leaver's own tick, the
sit case, and a player at another table receiving nothing; its collector is
count-driven (resolve at N ticks, a 5s deadline as the failure path) rather
than window-driven, because a fixed window opened before a request is a bet on
how long that request takes under load. `apps/web/test/event-store.test.ts`
pins the ring-buffer rule, including a 60-tick flood that must not evict the
one real event behind it. **`@gl3/shared`
`0.1.19` → `0.1.20` and `@gl3/plugin-sdk` `0.1.11` → `0.1.12`** (its
`@gl3/shared` range tightened to `^0.1.20`), both additive patches,
**unpublished** pending the user's approval after a registry check.

## What M3 established that later work must not undo

- **Lock ordering is per row-pair, not one global rule for the whole app.** There
  are two orders and they do not conflict: gang↔player goes through
  `lockGangAndPlayerForUpdate` (UUID comparison); location↔player is **always
  locations first** — a single location via `lockLocationForUpdate` (bullets;
  theft's steal/sell/repair through `tx.locks.location`), or
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
  copies are kept in step **by hand**, but drift is no longer silent:
  `apps/server/test/effects-parity.test.ts` parses one fixture, one minimal
  item and one invalid item through both copies of `WeaponEffectsSchema` and
  fails if the answers differ. It imports each package's `src/effects.js` by
  relative path — neither manifest exports an `./effects` subpath, and adding
  one purely to make a test resolve was refused. The real fix is still the
  equipment/inventory split the design defers to the item-economy cluster.
- **`player_stats.backfire` is now the backfire mechanic's lifetime counter.**
  The V2-derived column (integer, default 0) is incremented once per backfired
  shot and rendered on the public profile. See "Money ranks, backfire and
  weapon condition" below for the whole cluster.
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
- **`@gl3/shared`'s `index.ts` export order is no longer alphabetical.**
  `dto/online.js` and `dto/forum.js` were appended after `dto/oc.js` rather
  than sorted in (`forum` belongs before `gangs`); harmless — barrel exports
  don't care about order — but the next reader scanning for a DTO by eye will
  be misled. Fix whenever that file is next touched.
- **The bounty row DTO carries `targetId` and `targetPlayerId` (and
  `placerPlayerId` with no `placerId` counterpart) as duplicate values under
  two keys.** `targetPlayerId`/`placerPlayerId` were added this cluster so
  `PlayerLink` has a stable id to link against everywhere a bounty row
  renders; `targetId` already existed and means the same thing. A
  consolidation pass — one id field per party, named consistently — is a
  clean follow-up, not urgent since both fields agree by construction.
- **`MailDriver`'s error logging uses string interpolation, not a structured
  log object** (`apps/server/src/mail/driver.ts:30,35`), unlike the rest of
  this codebase's logging convention. Cosmetic; `MailDriver.send` never
  throws regardless of what it logs (see below).
- **The `resend` backend's network-failure branch (a rejected `fetch`) has no
  test.** `MailDriver.send`'s never-throws contract is proven for the `log`
  driver and for a resend *rejection response*, but not for the transport
  itself throwing. The registration and forgot-password routes both rely on
  never-throws to avoid needing a try/catch around `mail.send` (see the next
  item) — this is the one branch of that contract that isn't pinned by a
  test.
- **`POST /api/auth/register` does not wrap `mail.send` in a try/catch.**
  Deliberate, not an oversight: `MailDriver`'s contract is never-throws, so a
  wrapping catch would be defensive against a guarantee the driver already
  makes. Latent only, and only as strong as the untested branch immediately
  above — if that branch is ever wrong, registration itself would 500 on a
  mail-transport failure instead of completing with the email merely
  undelivered.
- **A verified player who opens `/verify` anyway sees a form with no way
  back.** There's no redirect-if-already-verified and no link off the page;
  harmless (the form's own submit just 404s or no-ops on an already-consumed
  code) but a rough edge worth closing in the same pass that revisits the
  auth pages.
- **Every parallel query the `Shell` component fires can independently
  redirect on a 403.** A gated player with several panels loading at once may
  see `window.location.assign("/verify")` called more than once — idempotent
  (the second call is a no-op once the first has navigated), but worth a
  once-guard so it isn't relying on that idempotence by accident.
- **Player names outside the spec's linking list are still plain text.**
  `PlayerLink` shipped for the pages the design named; Leaderboards, Mail,
  Dashboard, Properties, Detectives, Rounds and OC all render a username
  somewhere and none of them link it yet. A follow-up sweep, not scoped to
  this cluster.
- **The forum listing's `ORDER BY sort` has no tiebreaker.** Two forums with
  the same `sort` value order arbitrarily (whatever Postgres returns without
  a second key) rather than deterministically. Cosmetic until an admin
  actually creates two forums at the same sort rank.
- **`ForumTopicSchema` doesn't carry its own `forumId`.** A page holding only
  a `ForumTopic` (the reply view) can't link back to the forum it belongs to,
  can't seed a targeted cache invalidation narrower than the whole forum
  prefix, and can't pre-seed the post cooldown from that view alone. Additive
  — a candidate for the next `@gl3/shared` bump that touches forum DTOs,
  not urgent enough to justify one on its own.
- **`apps/migrate/src/migrators/forum.ts:53` has a redundant `isGangForum`
  check (defined at line 24) sitting beside a map lookup that already encodes
  the same information**, and the cascade-skip branch for a gang forum's own
  topics and posts has no direct test — it's correct by inspection (the
  migrator never populates a `forumV3ById`/`topicV3ById` entry for anything
  under a gang forum, so every downstream lookup already misses), but nothing
  turns red if that inspection is ever wrong.
- **`POST /api/auth/register` answers a distinct 409 `email_taken` when the
  address is already registered, while `POST /api/auth/forgot` always
  answers 200 regardless of whether the address exists.** That is an
  intentional inconsistency, not an oversight missed on one of the two
  routes: register's 409 is unavoidable (a duplicate account can't silently
  succeed) and is itself a small email-enumeration surface — an attacker can
  probe whether an address has an account by registering with it. Forgot's
  anti-enumeration 200 doesn't close that surface, only avoids adding a
  second one. Revisit together if enumeration hardening is ever prioritized;
  fixing one without the other doesn't remove the leak.

**Resolved, but the reasoning matters if you touch these areas:**

- **The public profile route used to be the only unauthenticated,
  un-rate-limited route in the app**, running a four-table join per
  anonymous hit. Accepted at the time because the join is keyed on a primary
  key with at most one result row, so the exposure was amplification at
  request rate, not enumeration — but "revisit before deployment" was always
  the plan. Closed on the social cluster: the route now sits behind the same
  `tokenBucket` (60/60s) every other rate-limited route uses.
- **`RegisterRequestSchema.email` used to have no explicit `noNulByte`
  guard**, safe only incidentally because zod's `.email()` regex happened to
  reject NUL. Closed on the social cluster along with making the field
  required: `RegisterRequestSchema.email` is now
  `noNulByte(z.string().email().max(254))`, an explicit guard rather than a
  fragile coincidence of the regex.

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


---

## Dynamic plugin loading (`PLUGIN_PACKAGES`)

The plugin story above assumes an operator who builds from source. GL3 deploys
as Docker, and for that operator it does not work at all: `Dockerfile.server`'s
runtime stage carries only compiled `dist/` dirs plus the `node_modules` that
`npm ci` resolved at **build** time, and `installed-plugins.ts` is compiled into
`apps/server/dist`. There is no toolchain to rebuild it with. Adding any
third-party plugin meant rebuilding the image, and the image's plugin COPY
lines only ever covered our own workspace packages.

`PLUGIN_PACKAGES` is the second route in. Each entry is an npm package
specifier resolved out of `PLUGIN_DIR` — an operator-controlled directory, in
practice a volume populated by an init container running
`npm i --prefix /data/plugins @acme/plugin-x`, the same slot the migration
initContainer already occupies. Install becomes an env var and a restart.

- **`apps/server/src/plugins/dynamic.ts`** resolves, imports, and validates.
  Resolution tries `createRequire().resolve` first (it implements the whole
  algorithm including `exports` maps) and falls back to reading the package's
  own `package.json` — needed because `require.resolve` answers
  `ERR_PACKAGE_PATH_NOT_EXPORTED` for an **ESM-only** exports map, which a
  modern third-party plugin may legitimately ship. Every GL3 plugin declares
  `default` and resolves on the fast path; the fallback exists for everyone
  else. With no `PLUGIN_DIR`, a bare `import(spec)` resolves from the server's
  own `node_modules`.
- **`parsePluginManifest`** (new SDK export) is what replaces the compile-time
  check. `definePlugin` is now a typed wrapper over it — one schema, two entry
  points. The static import never verified more than "the default export
  matches `PluginManifest`" for a prebuilt package anyway, since `tsc` never
  sees a registry plugin's sources; a zod parse does that job against what
  actually shipped, and names the offending field.
- **`PLUGIN_PACKAGES` entries load unconditionally**, unlike `PLUGIN_IDS`.
  "Installed but not enabled" is a real state for a plugin compiled into the
  server and no state at all for one an operator installed and then named; a
  second variable would only have forced them to discover a manifest id that
  `available.ts` is emphatic is not the package name.
- **Id collisions fail boot loudly** (`assertNoIdCollisions` in `index.ts`),
  naming the package and the id. `withCorePlugins` de-duplicates silently,
  which is right for its own case and wrong here — an operator whose
  `@acme/casino` collided with ours would otherwise see it simply never appear.

### The hazard this had to close first

Two module instances of `@gl3/plugin-sdk` now exist in a live deployment: ours
under `/app`, and the plugin's own under `/data/plugins`. `plugins/routes.ts`
mapped a plugin's thrown error to its HTTP status with
`error instanceof PluginError`, which is **false** across two instances — so
every deliberate 400/409/423 from a dynamically loaded plugin would have
surfaced as a 500. The SDK had already met this exact problem with zod
(`events.ts:14`, duck-typed on purpose) and now states it once, structurally:
`PluginError`, `InsufficientFundsError`, `InsufficientGangFundsError` and
`JobAlreadyAppliedError` carry `Symbol.for` brands, and the SDK exports
`isPluginError` and friends. `routes.ts` and `jobs.ts` use the guards.

Each guard also accepts a legacy `name`+shape match, because every plugin
published against `0.1.0`–`0.1.8` predates the brand. `isPluginError`
additionally requires `code`/`status` on that arm — the two fields the caller
goes on to read, where a bare `name` match would produce `reply.code(undefined)`.

`ctx.ts:129/153` deliberately stay on `instanceof`: those catch core's own
`economy/ledger.ts` errors, thrown and caught inside core, one instance, never
crossing the boundary.

`filterPoint`'s `declared` Set is also per-instance, which weakens its
duplicate-name check across the boundary. Left alone on purpose —
`runFilterChain` routes by name *string*, so cross-instance filters still work,
and the loader's own collision pass covers what matters.

### Tests

`apps/server/test/plugin-dynamic.test.ts` (`@gl3/server:unit`, so it runs in
`verify:ci` with no DB) writes **real** packages to a tmpdir and really imports
them — a mocked `import` would prove nothing about the thing that actually
breaks. It covers the happy path, the ESM-only exports map, ordering, a
malformed manifest, a missing default export, an unresolvable specifier, and an
entry point that throws at module scope.
`packages/plugin-sdk/test/error-guards.test.ts` stands in for a second SDK copy
with classes carrying the same brand and name but a different class object, and
asserts `foreign instanceof PluginError === false` outright next to
`isPluginError(foreign) === true`. Both files were verified red: reverting
`isPluginError` to `instanceof` fails 2, deleting the ESM-only fallback fails 1.

`@gl3/plugin-sdk` → **`0.1.9`** (additive: `parsePluginManifest` plus the four
guards). **Not published** — the registry already serves `0.1.8` from another
session, and publishing needs the user's approval.
