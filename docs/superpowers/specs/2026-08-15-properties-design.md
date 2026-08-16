# Properties — design

**Date:** 2026-08-15
**Status:** approved
**Cluster:** third of four activating migrated-but-unread V2 tables
(`properties`). Follows
`2026-08-15-car-theft-garage-police-chase-design.md`; precedes the `rounds`
spec.

---

## 1. Scope

`properties` is V2's `propertyManagement` module (SPEC §1.3): ownable
per-location businesses. The migrated table carries `location_id`,
`plugin_id` (V2's `PR_module` string), `owner_player_id`, `cost` and
`profit` — and nothing else. No V2 gameplay code was ported; this spec is
therefore GL3-native, and like combat and theft its spec and tests are the
only behaviour record.

In scope:

- one new workspace-local plugin, **`properties`**, owning the table, its
  routes, its pages and its migrations
- the `properties` table moving from core to the plugin
  (`0010_relinquish_properties`, the `0007`/`0009` precedent)
- buying an unowned property at `cost` and selling one back at `cost`
- **lazy on-claim income**: profit accrues by wall-clock formula and is
  banked when the owner visits
- one player page (`/properties`) and one admin page (`/admin/properties`)
- profit share on sale: unclaimed income is paid out to the seller at
  sale time; the next buyer's accrual clock starts fresh at purchase

Out of scope, and deliberately so:

- **recurring tick jobs crediting owners.** Income is lazy — computed at
  claim time from `last_claimed_at`, no job, nothing to make idempotent
  (rule 1 does not apply because no job exists).
- **kill seizure, market bids, auctions, rent, taxes.** Buy/sell only; no
  new player↔player or plugin↔plugin gameplay edges.
- **`plugin_id` doing anything at runtime.** It is the migrated V2 module
  string, rendered as a label on the page and filterable in admin. A future
  cluster can make it dispatch; today it selects nothing (user decision,
  2026-08-15: "Label only, dormant").
- **owning more than one property per location per player.** One row per
  (location, owner) — a player may own in many locations, but a location's
  property has one owner at a time.

## 2. Table ownership

Core migration **`0010_relinquish_properties`** drops `properties`. The
plugin's migration creates:

```
p_properties_properties(id uuid pk,
                        location_id uuid not null references locations(id) on delete cascade,
                        plugin_id  text not null,
                        owner_player_id uuid references players(id) on delete set null,
                        cost   bigint not null default 0,
                        profit bigint not null default 0,
                        last_claimed_at timestamptz,
                        rate bigint not null default 0)
  unique (location_id)              -- one property row per location
  index  p_properties_location_idx on (location_id)
```

Derived columns are dropped in the move: the unique constraint replaces the
old index (a location has exactly one property row; the index and the
unique constraint would be redundant, so the unique wins and the plain
index goes). `last_claimed_at` and `rate` are new: `last_claimed_at` is
null exactly while unowned (and after `ON DELETE SET NULL`, which resets
the row to the unowned state), and `rate` is the per-hour income in cents,
admin-editable per property. `apps/migrate`'s `migrateProperties` retargets
to the plugin table and stamps `last_claimed_at = migration start` for
previously-owned rows (so migrated owners do not inherit a phantom
back-accrual from 2015); `rate` is hardcoded to `500` in the migrator (it
does not read `properties.income.default_rate` — see §4); admin create
reads the setting when `rate` is omitted.

No core code reads or writes `properties` today (verified by grep at plan
time; the migration census in `schema.test.ts` must be recomputed the same
way `0009` did — three FKs out, `players`, `locations` both stay in core).

Lock graph: the new `p_properties_properties` row reaches `locations` and
`players` by FK. **Every route that takes a player lock must take the
location lock first** — locations-first is the established order for the
location↔player pair (CLAUDE.md rule 6). Buying/selling/claiming lock
`locations[L]` then `player_stats[P]` then read/update the property row.
Neither admin route can be half of a deadlock cycle with those, but for
different reasons: the create INSERT takes `FOR KEY SHARE` on
`locations[L]` via its `location_id` FK and acquires nothing afterwards;
the update takes `FOR UPDATE` on one property row and nothing else — like
theft's admin car editor, it touches only the table the UPDATE itself
already owns.

## 3. Income model — lazy, on-claim

**The invariant:** `profit` is what has been *banked* (credited to the
owner's ledger, already paid out on a previous claim or travelling with a
sale), and `last_claimed_at + rate × elapsed` is what *accrues*. There is
no tick.

Accrual formula, evaluated inside the claim/sell transaction under the
player lock:

```
accrued = min(rate * floor((now - last_claimed_at) / interval '1 hour'), cap)
```

- `rate` is bigint cents per hour, per property, admin-editable.
- `cap` is a settings row (`properties.income.cap`, default `1000000` = $10k)
  capping the unclaimed pool so an absentee owner cannot return to a
  bottomless payout. The cap is on the *pool*, not per-claim: after a claim
  the pool resets to 0 and accrual restarts.
- The floor-to-hour is deliberate: profit arrives in whole-hour units, so
  a player who claims twice within an hour banks nothing the second time —
  cheap, deterministic, and testable without fake clocks.

**Claim (`POST /api/properties/:id/claim`):** locks location → player,
re-reads the row FOR UPDATE, verifies ownership (404 `not_owned` —
404-not-403, so existence is not probeable), computes `accrued`, adds it
to `profit`... no — computes `accrued`, zeroes it into the ledger:
`applyBalanceChange(player, +accrued, "properties.income")` and sets
`last_claimed_at = now`. `profit` is the running total *paid out* — it is
incremented by both a claim's `accrued` and a sale's `accrued` (see §5).
If `accrued == 0`
the route still resets nothing and returns `200 { claimed: "0" }` — a
no-op claim is free, does not move `last_claimed_at`, and is the cheap
answer to a player hammering the button.

**Sell (`POST /api/properties/:id/sell`):** locks location → player,
re-reads FOR UPDATE, verifies ownership. Payout = `cost + accrued`.
`applyBalanceChange(player, +payout, "properties.sell")`, sets
`owner_player_id = null`, `last_claimed_at = null`. The property returns
to the market instantly at `cost` — no listing delay, no price drift
(out of scope).

**Buy (`POST /api/properties/:id/buy`):** locks location → player,
re-reads FOR UPDATE. If already owned (by anyone, including the caller —
`already_owned` 409, and buying your own is the same error), 409. Debit
`cost` via `applyBalanceChange(player, -cost, "properties.buy")`,
insufficient funds → 409 `insufficient_funds` with no row change. On
success: `owner_player_id = player`, `last_claimed_at = now` (no free
back-accrual from the moment of purchase).

Claim/sell both *read* `accrued` from `last_claimed_at`; buy *writes* it.
Every money movement goes through `applyBalanceChange` (rule 3); every
route publishes after commit (rule 5).

## 4. Settings

One settings row per key. Keys are bare (SDK-namespaced as
`properties.<key>`, matching the theft precedent —
`properties-settings.test.ts` proves the un-prefixed form is the one the
parser reads):

| key | default | meaning |
|---|---|---|
| `income.cap` | `1000000` | max unclaimed pool, bigint cents |
| `income.default_rate` | `500` | per-hour rate applied when admin create omits `rate` (the migrator still hardcodes `500` — see §2) |
| `admin.can_edit_rate` | `true` | informational only — the admin page always edits `rate`; key exists so a future runmode can pin it |

Settings are read at boot (the boot-time snapshot pattern); tests that need
different values boot their own server (`theft-chase.test.ts` precedent).

## 5. Events and pages

**No new `GameEvent` variant.** Plugin events only — adding a variant
breaks three places (CLAUDE.md conventions; the `CORPUS` drift guard runs
only under the full suite). Three plugin events, all audience **player**
(the B1 lesson from the theft final review, ledger-bound: the plan
deviating from the spec on audience survived eight task reviews; the spec
table below is the binding authority):

**Events table — binding version:**

| name (wire) | audience | describe | invalidates |
|---|---|---|---|
| `bought` | player | `{actorName} bought {propertyName} for {cost}` | `properties`, `me` |
| `sold` | player | `{actorName} sold {propertyName} for {payout}` | `properties`, `me` |
| `income` | player | `{actorName} claimed {amount} from {propertyName}` | `properties`, `me` |

Wire names are un-namespaced (`bought`/`sold`/`income`); `pluginId:
"properties"` in the envelope identifies the plugin — the theft Task-5
ruling: `toEnvelope` wraps as `plugin.event`, no auto-namespacing, and the
design doc's dotted names are shorthand.

**Player page (`/properties`, menu order 42):** a table of the world's
properties — name (location name), flavour label (`plugin_id`), rate,
owner name or "—", `cost` when unowned, and a per-row action: Buy when
unowned, Claim + Sell when yours, nothing when another's. Hand-written React in
`apps/web` (this cluster has no declarative-page precedent among
player pages for an action-per-foreign-row table — `garagePage` actions
are own-row only; writing it by hand keeps the row-action logic in one
place). Data from `GET /api/properties` returning a
`TableRowsResponse`-shaped `{ rows: [...] }`, every value a string.

**Admin page (`/admin/properties`):** the manifest `adminPages` field, a
`table` view node, columns `location`, `pluginId`, `owner`, `cost`,
`rate`, `profit` — no `id` column (ids travel as `select` `valueKey`
only, the `admin-ids-hidden` convention). Create/update forms for
`cost`/`rate`/`pluginId`/`name-less` — properties are identified by
location, so the create form is a location select, and update keys off
the same select.

## 6. Lock order — the property route family

All three money routes share one shape, and the location↔player order is
the pair CLAUDE.md rule 6 already names:

```
unlocked read: property row by id (404 if absent)
lock locations[L]            (tx.locks.location — locations first, always)
lock player_stats[P]         (tx.locks.player)
re-read property FOR UPDATE  (row cannot have moved; owner can have)
ownership/state check        (404 not_owned / 409 already_owned / insufficient_funds)
money movement               (applyBalanceChange inside the same tx)
update property row
publish after commit
```

The admin update route holds exactly one lock (the property row) and
touches no other table — the same "a transaction holding exactly one lock
cannot be half of a deadlock cycle" argument as theft's admin car editor,
with the same mandated comment. The admin create route's INSERT takes
`FOR KEY SHARE` on `locations[L]` via the `location_id` FK and acquires
nothing afterwards, so it likewise cannot be half of a cycle — see §2.

Regression test: `properties-lock-order.test.ts`, the
`theft-lock-order.test.ts` shape — a blocker connection holding
`locations[L]`, a real buy parking behind it, a real travel/steal
contending, refusing per-route error codes enumerated, no 40P01, ledger
invariant asserted per player. Red demonstration: invert buy to
player-first and watch Postgres's own deadlock log name the cycle.

## 7. Testing

- `properties-resolve.test.ts` — the accrual formula as a pure function:
  zero elapsed, partial hour floors to zero, cap clamps, unowned has no
  accrual (returns null/0), post-claim reset.
- `properties-routes.test.ts` — buy/sell/claim happy paths and every
  refusal: `not_owned`, `already_owned`, `insufficient_funds` (no row
  change, no ledger row), 404 unknown id, buy-after-sell returns the
  property to market, `last_claimed_at` write on buy, no-op claim leaves
  `last_claimed_at` untouched.
- `properties-events.test.ts` — all three events, `awaitOwnEvent`,
  envelope shape `{ type: "plugin.event", pluginId: "properties", name,
  payload }`, decimal-string money, published after commit.
- `admin-properties.test.ts` — the six-route admin surface: 403 non-admin,
  create-by-location, update cost/rate, bracket/validation refusals with
  DB-unchanged assertions, page-shape walk (no id column).
- `properties-lock-order.test.ts` — §6.
- `schema.test.ts` — census recomputed for `0010` (FK/index deltas), the
  `0009` precedent.

`npm run verify` is the gate; the migration retarget's own tests live in
`apps/migrate` (idempotency suite covers the new target via
`plugin-tables.ts`).

## 8. Registration sites

The nine, per CLAUDE.md (the eight + `vitest.workspace.ts` test-file
enumeration): plugin dir, both package.jsons, both tsconfigs,
`vitest.workspace.ts` srcAlias + every new test file in its project's
include list, `core-plugins.ts`, five COPY lines in `Dockerfile.server`
(`grep -c "packages/plugins/properties" Dockerfile.server` = 5),
`plugin-manifest-endpoint.test.ts`'s expectations grow the new plugin's
menu/pages/events — the tripwire that broke early on the theft branch.

Theft's final-review findings inherited as inputs: N1 (cross-describe
ordering) — the routes file keeps one describe; N2 (rate-limit sweep
reliance) — vary `remoteAddress` in admin tests; P1/P2 (unvalidated
payloads, `blankable`/`.coerce` holes) — cross-plugin, still parked, do
not fix here; N3 (orphaned rows) — properties' `ON DELETE SET NULL` owner
means a deleted player returns the row to market, the intended
unowned state, not an orphan.

## 9. M5 milestone framing

Completes the third of four clusters. After this, only `rounds` remains;
`money_ranks` shipped with cluster one, `cars/garage/theft_tiers` with
cluster two. The suite grows by roughly 6 test files / ~45 tests
(estimate; the plan records actuals).
