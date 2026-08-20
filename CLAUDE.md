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
round-19 failure does not explain this one. Three failures of that same shape
are now on record: the two above, plus a third on 2026-08-18, on
`feat/location-combat-modes`' merge-gate run (verify run 2 of 3) — same test
(`casino-lock-order`'s ABBA case, `survives A-plays-at-B's-table racing
B-plays-at-A's-table`), same shape (a bare 500 on `lockPlayersForUpdate`),
5/5 green standalone immediately after, and green on the full-suite re-run.
The intervening diff touched only travel admin semantics, a combat comment, a
schema test and a CLI usage string — nothing near casino or the lock helpers.
`plugins/routes.ts` logs the driver error's `cause` (SQLSTATE, detail, table)
from this branch on, which is the datum both earlier diagnoses lacked — but
the third occurrence still didn't capture it: `app.ts:46` sets `logger:
config.nodeEnv !== "test"`, so the `request.log.error` cause-logging was a
no-op under the test environment, the one place the flake occurs. Note the
3.5x speedup raises concurrency *density*, which is a plausible reason a
latent contention bug surfaced when it did.

**That gap is now closed.** Commit `3e3e5d7` (landed on `main` before
`feat/blackjack-tables` started) added a `console.error` fallback for the
driver-cause log line, one that survives the silenced test-environment
logger. `feat/blackjack-tables`' Task 13 is the first proof it works: the
new `test/casino-table-lock-order.test.ts` deliberate-inversion case
produced a **real, captured `40P01`** with mutual `ShareLock` detail, not
the bare 500 this repo had chased four times before. The *solo*
`casino-lock-order` ABBA flake had not recurred as of that branch, so it is
still unconfirmed against the fix directly — but the logging path it would
need is now proven live under test, not theoretical. The next occurrence
should carry its SQLSTATE.
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

**Game art** has since shipped on `feat/asset-images`, the first capability
GL3 has that V2 never had: V2's schema carries no image column on any content
table, so there was nothing to port and `apps/migrate` is untouched. Core
migration `0012_assets` adds `assets` (content-addressed — the sha256 IS the
storage key, so dedup and `Cache-Control: immutable` are free) and
`entity_assets` (`(scope, entity_id, slot) → asset`). **`entity_assets` has no
foreign key on `entity_id`, deliberately**: the obvious design — an `asset_id`
column per entity table — would add an FK from every plugin table into a core
one, and a foreign key is a lock (rule 6). This adds exactly one FK,
core-to-core; the orphan rows it therefore permits are the sweeper's job
(`assets/sweep.ts`, with a one-hour grace so a sweep cannot delete an image
mid-bind, and core-scope-only orphan detection because core cannot enumerate a
plugin's tables). Storage is `StorageDriver` with two REAL backends —
filesystem for dev/test, S3-compatible for production — so the suite never
exercises the S3 path; `test/asset-driver-contract.test.ts` runs the same cases
against a live endpoint when `S3_TEST_ENDPOINT` is exported. Uploads are a
CORE route because plugin routes take a Zod-parsed JSON body; there is no
`@fastify/multipart` and no `sharp` (pure-TS sniffing and header parsing in
`assets/image.ts`), and the per-type `addContentTypeParser` entries are
mandatory because `app.ts`'s catch-all `*` parser would read image bytes as a
string. Binding checks `hasPermission(scope)`, not blanket admin. The SDK
gained `providesAssets` (no `scope` field — the loader derives it), `ctx.assetSlots`
and a **batched-by-construction** `ctx.assets.resolve`; the view vocabulary
gained `image`, `table.columns[].render: "image"` and the admin-only
`assetBinder`. Art comes in two shapes: **per-row** (an item, a town, a car)
and **singleton** (`singleton: true`, bound against the nil UUID
`SINGLETON_ENTITY_ID`), which is what gives a PAGE a picture — jail, hospital,
bank and the casino floor have no row to hang art on. A page's view is static
data built at boot and cannot carry a URL uploaded later, so the `slotImage`
node names its slot and the client resolves it via
`GET /api/assets/slot/:scope/:slot`; core's 20 `page-*` banners render from one
route→slot map in `Shell.tsx`, not from nineteen page components. The admin art
section is derived from the registry, so a declared slot is always bindable —
the first cut hand-wrote three binders and shipped `location` and `rank` with
nothing rendering them. `@gl3/shared` → `0.1.10`, `@gl3/plugin-sdk` → `0.1.5`,
both published.

**Hospital self-admission and local facility rosters** have since shipped on
`feat/hospital-jail-social`: `POST /api/hospital/checkin` is the first
voluntary route into hospital (free — the stay, sized off missing health, is
the price), and both facilities gained a location-scoped roster
(`GET /api/hospital/local`, `GET /api/jail/local`) plus three routes that act
on another player at the caller's own town — paid discharge, bail and a
free-to-attempt bust that jails the caller on failure instead of the target.
This cluster adds **no migration and no new lock-graph edge**:
`schema.test.ts`'s FK and index counts are unchanged, and all three
two-player routes open with combat's own `lockPlayersForUpdate` over
`[caller, target]`, reusing the player↔player pair combat already
established rather than adding a fourth. It also adds no new `GameEvent`
variant — every fact it produces reuses `player.released`,
`player.discharged`, `player.jailed` and `notification.created` — so none of
the four places a new variant would touch needed changing.
`@gl3/shared` → `0.1.12`, additive, **not yet published**. It was drafted as
`0.1.10`, but the registry had already been given both `0.1.10` and `0.1.11`
by another session's work by the time this one tried to publish — those two
numbers belong to other clusters, not this one.

**Location combat modes** have since shipped on `feat/location-combat-modes`:
a per-town `locations.combat_mode` (`'open'` | `'underground'`, default
`'open'` — core migration `0013`, no FK, no index) reintroduces V2's rule
that residents of a town are invisible and unshootable without a live
detective report, but scoped to whichever towns an admin flips rather than
every town. This is combat's fifth plugin→plugin dependency edge
(`@gl3/plugin-detectives`, after combat→inventory, bounties→combat,
bullets→properties, bullets→travel): detectives gained a plugin migration
(`0002_report_expiry`, a nullable `expires_at` stamped at hire as
`ends_at + expire`-at-hire-time, since a combat-side reader cannot reach
detectives' own settings namespace) and a read-only export,
`activeReportTargetIds`, that combat calls under a plain SELECT — no lock
taken, no row written. In an underground town, `POST /api/combat/attack/:id`
409s `no_detective_report` unless the target is in that set, checked *after*
the existing `same_gang`/`protected` checks so town mode never leaks through
error-ordering differences; the cooldown still burns on the refusal, same as
every other 4xx. `GET /api/combat/targets` filters to the caller's live
report set **in SQL, before the `LIMIT 50`** — a post-limit filter would hide
a legally attackable reported player outranked by 50+ bystanders, which is
exactly what `test/location-combat-modes.test.ts` proves with 51 unreported
stragglers ahead of one reported target. A report is not consumed on a
shot — time expiry only, deliberately, because GL3 combat is multi-shot
whittling and per-shot consumption would price a kill at `cost × shots`.
Hospital and jail rosters stay visible in every mode (V2's own only in-town
leak, kept as counterplay). `travel` exposes the flag on both the listing DTO
and a new admin `select` (`GET /api/admin/travel/combat-modes` feeds its
`optionsSource`; 400 `invalid_combat_mode` is handler-level, since the
loader answers a zod-enum failure with the generic `invalid_request` before
a plugin handler ever sees it), and `apps/migrate` gained
`--town-combat-mode` to default every imported town to `underground` for
operators who want V2 rules everywhere. No new `GameEvent` variant and no
new lock-graph edge — every new read is a plain SELECT, recorded so nobody
adds a lock-order test for an edge that doesn't exist. The operational
constraint is real, not theoretical: flipping a town to `underground` on a
deployment that never loaded `detectives` fails every attack and target-list
read there, since `p_detectives_searches` won't exist; the default `'open'`
makes it opt-in, and admin-side validation that `detectives` is loaded is
deliberately out of scope (travel's admin page has no view of the loader's
plugin list). `@gl3/shared` → `0.1.13` (`mode` on the targets response,
`combatMode` on the location DTO), additive, **published** with the user's
approval after a registry check — `npm.gl3.dev` now serves `0.1.1` through
`0.1.13` (`0.1.12`, the hospital cluster's bump, had landed on the registry
by another session in the meantime).

**Email verification, presence and the forum** have since shipped on the
social cluster: three SPEC §1 gaps V2 had and GL3 had never ported, closed
together. Email verification is a hard 403 gate (`email_unverified`) behind
one Redis flag (`unverified:<id>`, no TTL — verification is the only exit,
and login re-asserts it from the `players` row so a Redis flush self-heals
rather than silently unlocking an account), set by core migration
`0014_email_verified.sql`'s new nullable `players.email_verified_at`, which
backfills every existing row to `now()` in the same migration — grandfathering
is total, nobody already playing is ever asked to verify. Verification and
password-reset tokens are both 12-/32-byte random codes consumed by `GETDEL`
(rule 2), and a reset kills every session on the account through a new
`playersessions:<playerId>` Redis SET reverse index, not just the session
that reset it. `requireAuth` is now the one choke point for both the gate and
presence — every authenticated request, core or plugin route alike, calls
`touchPresence` (an unconditional heartbeat `ZADD` plus a `SET NX EX 60`-
throttled `players.last_seen_at` write, rule 2 again) before the unverified
check runs. `GET /api/online` reads that ZSET lazily (no cron, the
`ensureCurrentRound` settle-at-read shape) into two windows, concealing an
underground town's residents' location the same way combat and travel
already do. The forum (`@gl3/plugin-forum`) is the **nineteenth plugin and
the ninth to own tables and migrations**, so **nine of nineteen plugins now
declare migrations**; it takes no explicit lock anywhere — a reply's
`post_count`/`last_post_at` update is a plain self-serializing `UPDATE`, and
its FKs impose no second lock in the same transaction to invert against — so
it adds no new lock-graph edge and deliberately has no lock-order test.
Moderation is `hasPermission("forum")`, admin CRUD is `adminPages`. M4
gained a ninth migration phase, after social, for forum content; V2's gang
forums (`F_id < 0`) are reported-skipped wholesale, along with everything
filed under one. `@gl3/shared` → `0.1.14` and `@gl3/plugin-sdk` → `0.1.7`
(the SDK's first-ever route-level query-string support — an optional `query`
zod field on `route()`, needed because the forum plan never anticipated
`?page=`) — **neither is published**, pending the user's approval.

**Premium membership** has since shipped on `feat/membership`: V2's
`membership` module, ported and improved as `@gl3/plugin-membership`, the
**20th plugin and the 10th to own tables and migrations** — its one table,
`p_membership_packages`, has no foreign keys, no core migration, and adds no
lock-graph edge, so `schema.test.ts` is untouched. Status lives in the core
`player_timers` row keyed `membership` (already migrated from V2 `userTimers`
verbatim), made live rather than moved. The SDK gains generic per-player
timers, `tx.timers.get/set/clear`, over that table — `clear` returns a
deleted-boolean, which is what makes lazy expiry notification (in
`membershipUntil`, DELETE-as-claim, no cron, no Redis marker) a once-only
claim rather than check-then-act. Buy keeps V2's stacking rule verbatim,
`max(now, current expiry) + duration`; gift reuses the existing player↔player
edge (`tx.locks.player`, sorted) rather than adding one, so per the rule-6
corollary above there is deliberately no new lock-order test. Benefits are a
filter point, `membership.benefits` (the `casino.games` shape), with three
subscribers each a new plugin→plugin dependency edge — the **6th through
8th**, after `bounties→combat`, `combat→inventory`, `bullets→properties`,
`bullets→travel` and `combat→detectives`: `crimes→membership` (Getaway
Driver, `ceil(cooldown × 0.75)`), `travel→membership` (Frequent Flyer,
`ceil(cost × 0.25)`), `theft→membership` (Slide Hammer, `min(100, floor(chance
× 1.1))`) — each applied at both its listing route and its acting route.
Plugin events only, so this cluster adds no `GameEvent` variant and touches
none of the four places a new one would. Admin is package CRUD via
`adminPages` with a blankable rename, pushing the `admin-ids-hidden` floor
from 12 to 13 sections; `/membership` is manifest-declared (the theft
precedent). M4 gained the `premiumMembership` → `p_membership_packages`
migrator (ten plugin-owned tables now in the idempotency census) and turned
up a fixture defect, not a spec or migrator bug — the test fixture DDL had
named the description column `PM_name` where real V2 uses `PM_desc`, fixed on
this branch (the `PR_owner` defect class again). `@gl3/shared` is
**untouched** by this cluster: the membership views are generic
manifest-table pages with no shaped response DTO to add, so the shared
package stays wherever prior work has left it. `@gl3/plugin-sdk` → **`0.1.10`**
for `tx.timers`, additive, **unpublished** pending the user's approval after a
registry check.

**Blackjack tables** has since shipped on `feat/blackjack-tables`: the casino
gains multiplayer seats, and blackjack moves from the solo `casino.games`
registry to a second, parallel `casino.tableGames` one built for it (V2 never
had single-player blackjack). `p_casino_tables` and `p_casino_seats` (casino
migrations `0003`–`0006`, two unique indexes plus a five-seat `CHECK`, no core
migration) hold the shared row a hand lives at and a player's chair; both FKs
cascade and are already held `FOR UPDATE`, so this is the rule-6 non-event
again. The lock order is one new edge everywhere: `tx.locks.location` on the
table's town, then ONE sorted `tx.locks.player` over every seated player plus
the house owner plus any not-yet-seated caller, then the table row `FOR
UPDATE` (`lockTable`) — up to six player rows where solo `play` locks at most
two, since every seat can belong to a different table in a different town.
There is no cron: `advanceTable` lazily deals, auto-stands, or settles on
every read or write, bounded at 15 passes, and stamps each pass with the
deadline it just cleared (not "now") so a whole abandoned hand resolves in one
read; exhaustion by a rogue `autoAct` throws a loud `invalid_turn` 500 rather
than building refund machinery, matching the install-time trust model.
`settleHand` pays every in-hand seat and fires the property-board cluster's
bankruptcy takeover for the first *short-paid* winner (not the first winner),
latching to the sink for every payout after; it now retains the final hand's
state rather than clearing it, so the betting-phase view between hands shows
the just-finished reveal. A wager-0 leave bypasses both the game registry and
the clock, the one escape hatch a table needs once its game plugin is
uninstalled. The table view polls every 2.5 seconds rather than subscribing to
events — a hand can advance with no request in flight to publish from — so
this cluster adds no new `GameEvent` variant and `eventCopy.ts` /
`ws/invalidation.ts` stay untouched. With blackjack gone from the solo
registry, the solo hub's own tests (`casino-play`, `casino-act`,
`casino-lobby`, `casino-lock-order`) converted to run against FARO, a small
deterministic synthetic `GameDef` installed via its own test-only plugin.
`test/casino-table-lock-order.test.ts` is added to rule 6's regression list
below. `@gl3/shared` → `0.1.18` for the table DTOs, additive, **unpublished**;
`@gl3/plugin-sdk` is untouched.

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
   independently. Casino's table cluster (`feat/blackjack-tables`) widens the
   same locations-first edge rather than adding a new one: `tx.locks.location`
   → ONE sorted `tx.locks.player` over every seated player plus the house
   owner plus any not-yet-seated caller → the table row `FOR UPDATE`
   (`lockTable`), up to six player rows against solo `play`'s two, since every
   seat can belong to a different table in a different town at the same
   instant. Regression tests: `test/gang-lock-order.test.ts`,
   `test/travel-lock-order.test.ts`, `test/combat-lock-order.test.ts`,
   `test/theft-lock-order.test.ts`, `test/properties-lock-order.test.ts`,
   `test/properties-consumer-lock-order.test.ts`,
   `test/casino-lock-order.test.ts`, `test/casino-table-lock-order.test.ts`
   (`economy/ledger.ts`).

   The asset cluster adds **no** lock-order test, because it adds no edge:
   `entity_assets` carries a foreign key only to `assets`, and no gameplay path
   locks either table. That was the whole reason the slot-registry shape was
   chosen over an `asset_id` column per entity table — see `docs/STATUS.md`.

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
  42P01. Nine plugins now own tables (`inventory`, `oc`, `bounties`,
  `detectives`, `combat`, `theft`, `properties`, `casino`, `forum`), so this catches far more files than it
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
  both stages). **Those two serve a from-source deployment only.** GL3 deploys
  as Docker, where the runtime stage has no toolchain and cannot rebuild the
  static import map — there, a plugin arrives through `PLUGIN_PACKAGES` +
  `PLUGIN_DIR` (`plugins/dynamic.ts`), resolved and zod-validated at boot,
  needing **zero** registration sites and no image rebuild. Note the
  consequence: a dynamically loaded plugin brings its own `@gl3/plugin-sdk`
  copy, so **never use `instanceof` on an SDK error class across the
  plugin/core boundary** — use `isPluginError` and its siblings. The eight
  below are:
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
