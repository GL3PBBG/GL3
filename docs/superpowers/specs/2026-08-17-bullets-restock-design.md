# Bullet restock, admin options and the price/quantity caps

Date: 2026-08-17
Status: implemented on `feat/bullets-restock` (see `docs/STATUS.md`)
Scope: `packages/plugins/bullets`, `packages/plugins/properties` (one filter
point), `packages/shared` (one DTO), `apps/web` (the Bullets page),
`apps/migrate` (one rename map).

---

## 1. The defect

`locations.bullet_stock` has exactly three writers in the tree:

| Writer | Effect |
| --- | --- |
| `packages/plugins/bullets/src/index.ts:180` | decrement on purchase |
| `POST /api/admin/bullets/stock` (`index.ts:49`) | admin sets an absolute value |
| `apps/migrate/src/migrators/locations.ts:18` | one-time import of V2's `L_bullets` |

There is no restock of any kind — no job, no tick, no lazy accrual. Stock
drains monotonically to zero and stays there until an admin intervenes. V2
restocked hourly; GL3 never ported that.

## 2. The V2 mechanic

From `bullets.inc.php` (`restock()` / `getNewBulletStock()`), supplied verbatim:

- a single global cursor setting, `lastBulletRestock`, holding an epoch second
  floored to the hour
- `thisHour = strtotime(date("Y-m-d H:00:00"))`
- `hours = floor((thisHour - lastRestock) / 3600)`, **clamped to 12**
- `hours == 0` → return, cursor untouched
- for **each** location, an *independent* draw: the sum of
  `mt_rand(minPerHour, maxPerHour)` over `hours` iterations
  (defaults 2250 / 2750), added to `L_bullets`
- then a global clamp: `UPDATE locations SET L_bullets = $max WHERE L_bullets > $max`,
  `maxBulletStock` defaulting to 40000
- cursor := `thisHour`

V2's `adminModule::method_options()` exposes four of these as admin-editable
settings: `maxBulletCost`, `bulletsStockMinPerHour`, `bulletsStockMaxPerHour`,
`maxBulletBuy`. `maxBulletStock` is read by `restock()` but is *not* in that
form — this design exposes it too, rather than leaving a 40000 nobody can reach.

## 3. Decisions taken during brainstorming

Each of these was a fork with a live alternative; recording them so the
implementation does not relitigate them.

**3.1 Tunables stay on the boot snapshot; only the cursor is read live.**
`apps/server/src/settings/load.ts` reads `settings` once at boot into a
`Record<string,string>`, and `ctx.settings.get` (`apps/server/src/plugins/ctx.ts:291`)
is a synchronous lookup over that snapshot, namespaced `<pluginId>.<key>`.
Editing a tunable therefore requires a **full process restart** — every replica.
That is accepted: nine other consumers already work this way (`hospital.*`,
`combat.*`, `oc.*`, `theft.*`, `casino.*`, rounds' payout table), and
live-reading only the bullets keys would make bullets the odd one out. The
cursor is the exception and is not negotiable: a value that moves every restock
cannot live in a boot snapshot, so `bullets.last_restock` is read and written
through `tx.db` inside the transaction.

**3.2 The admin options form is GL3's first runtime `settings` writer.**
`ctx.settings` is read-only (`{ get }`). No SDK change is needed: `bullets`
already mirrors core-owned tables in its own `schema.ts` (`locations`,
`player_stats`) and writes them through `tx.db`. `settings` joins that list as a
third mirror. Consequence to state plainly in the UI: **an options edit takes
effect on the next server restart**, not the next request.

**3.3 The restock is lazy, fired by a new `GET /api/bullets/shop`.**
Three constraints force this shape:

- `bullets` is a core plugin, and `buildApp` throws at boot if a core plugin
  declares `jobs`. A BullMQ repeatable job is unavailable.
- Restock-on-purchase alone **deadlocks**: `apps/web/src/pages/Bullets.tsx:35`
  disables the button when `count > here.bulletStock`, so at zero stock nobody
  can buy, so the restock that would refill it never runs.
- The page's current stock read is `useLocations()` → `GET /api/locations`,
  owned by the **travel** plugin (`packages/plugins/travel/src/index.ts:47`).
  Hooking restock there would give travel a dependency on bullets and fire the
  restock on travel page views.

So the trigger is a read the player can always reach, owned by the plugin whose
state it mutates. The precedent is `ensureCurrentRound` — lazy settle under an
advisory lock, no cron (`apps/server/src/game/rounds/service.ts:205`).

The new route also fixes a live display bug for free: the page renders
`here.bulletCost` (the location's admin price) while the buy route charges the
franchise owner's **lever** when a factory is owned (`bullets/src/index.ts:140`),
so an owned town currently shows a price it will not charge.

**3.4 `bullets.max_cost` is enforced twice** — rejected when the owner sets the
lever, and clamped again when the price is charged.

**3.5 The lever rejection reads its cap through its own transaction.**
`runFilterChain` (`packages/plugin-sdk/src/filters.ts:83`) threads the *applying*
plugin's ctx into every subscriber, so inside a `properties.leverSet` subscriber
`ctx.settings.get("max_cost")` would resolve `properties.max_cost`. This is the
same mislabelling trap CLAUDE.md already records for events. The subscriber
therefore opens its own `ctx.transaction` and reads the `settings` row for
`bullets.max_cost` directly. One extra transaction on a rare route; no core and
no SDK change. (The alternative — teaching the loader to build a ctx for the
*subscribing* plugin — is the correct general fix and would retire the trap for
events too, but it changes every existing subscriber's semantics and is far
outside this cluster.)

Rejection itself works: `runFilterChain` has no try/catch, so a subscriber's
`PluginError` propagates and the loader maps it.

**3.6 The per-location admin form stays, and keeps its direct stock setter.**
Travel's town admin edits only `name`, `travelCost`, `travelCooldownSeconds`
(`travel/src/index.ts:329-343`), so bullets' section is the only editor of
`bullet_cost` anywhere in the game, and travel's "Add town" creates locations at
`bullet_stock` default 0. The direct stock setter is a deviation from V2 (where
stock came from `restock()` alone) kept deliberately as an ops override.

**3.7 Unset `max_cost` and `max_buy` mean unlimited.** V2's `loadSetting` calls
for those two pass no default.

## 4. Settings keys

`ctx.settings.get` namespaces as `bullets.<key>`, but
`apps/migrate/src/migrators/settings.ts:17` copies V2's `S_key` **verbatim**. A
migrated game would therefore land flat keys that `ctx.settings.get` can never
find, and every operator's tuned values would silently revert to defaults. The
settings migrator gains a rename map:

| V2 key | GL3 key | Default when absent |
| --- | --- | --- |
| `bulletsStockMinPerHour` | `bullets.stock_min_per_hour` | 2250 |
| `bulletsStockMaxPerHour` | `bullets.stock_max_per_hour` | 2750 |
| `maxBulletStock` | `bullets.max_stock` | 40000 |
| `maxBulletCost` | `bullets.max_cost` | unlimited |
| `maxBulletBuy` | `bullets.max_buy` | unlimited |
| `lastBulletRestock` | `bullets.last_restock` | 0 |

Carrying a years-stale `last_restock` over is harmless — V2's own 12-hour clamp
bounds the catch-up. The map is applied key-by-key in the existing loop, so the
migrator's `onConflictDoUpdate` idempotency is unchanged.

## 5. Components

### 5.1 `packages/plugins/bullets/src/settings.ts` (new)

Parses the five tunables out of the `ctx.settings` snapshot. Follows the
existing per-plugin parser convention (`theft/src/settings.ts`,
`oc/src/settings.ts`, `combat/src/settings.ts`) — the SDK exposes no parser and
each consumer owns its own.

`settings.value` is unbounded admin-edited `text`, so every read is defensive:
a non-numeric, negative or absent value falls back to its default. One specific
guard, recorded because `combat/src/settings.ts:109` already shipped the same
trap: `randomInt(min, max + 1)` **throws** when `min > max`, so an admin who
sets `stock_min_per_hour` above `stock_max_per_hour` would 500 every shop view.
The parser swaps them (or collapses to `min`) rather than passing them through.

### 5.2 `packages/plugins/bullets/src/schema.ts` (extended)

Adds a mirror of the core-owned `settings` table (`key` text PK, `value` text),
in the same style and with the same comment rationale as the existing
`locations` / `player_stats` mirrors. No manifest `tables` entry and no
migration — core owns it.

### 5.3 `packages/plugins/bullets/src/restock.ts` (new)

```
restockIfDue(tx, tunables):
  thisHour := SELECT extract(epoch from date_trunc('hour', now()))::bigint
  last    := settings['bullets.last_restock'] (0 if absent/garbage)
  hours   := floor((thisHour - last) / 3600), clamped to [0, 12]
  if hours == 0: return "not due"

  SELECT pg_advisory_xact_lock(7461003)
  re-read last; recompute hours; if hours == 0: return "raced"   -- double-check

  ids := SELECT id FROM locations ORDER BY id FOR UPDATE          -- ascending
  for each id:
    qty := sum over `hours` of randomInt(min, max + 1)            -- node:crypto
    UPDATE locations SET bullet_stock = LEAST(bullet_stock + qty, maxStock)
      WHERE id = id
  UPSERT settings['bullets.last_restock'] = thisHour
```

Notes on the shape:

- **Double-checked locking.** The unlocked pre-read means the common case (not
  due) costs one indexed row read and takes no lock at all. The re-read under
  the advisory lock is what makes N concurrent shop views produce exactly one
  restock and N−1 no-ops — the same structure as `ensureCurrentRound`.
- **Advisory lock id 7461003.** 7461001 is the first-admin claim
  (`auth/routes.ts:113`), 7461002 is rounds (`rounds/service.ts:26`).
- **`ORDER BY id ... FOR UPDATE` is a RULE 6 requirement, not a nicety.**
  The restock touches every location row. Taking them ascending matches
  `lockLocationsForUpdate`'s sorted convention, which travel already uses for
  its two rows, and every other location toucher (bullets' buy, theft,
  properties, casino) takes exactly one. Without the sorted pre-lock, a plain
  multi-row `UPDATE` would lock in scan order and could close an ABBA cycle
  against travel.
- **The clock is Postgres's**, via `date_trunc('hour', now())`, so the cursor
  and the comparison come from one clock rather than mixing Node's with the
  database's.
- **`LEAST(...)` replaces V2's second statement.** V2 adds, then globally
  clamps every row above the max. Since `hours > 0` guarantees every row is
  touched, a per-row `LEAST` is equivalent and saves a full-table update.
- **`randomInt` from `node:crypto`, never `Math.random`** (SPEC §7, the
  convention `combat/src/resolve.ts:40` and `theft` follow). Seeded RNG is not
  available: `ctx.job.rng` exists only on job contexts and this plugin cannot
  declare jobs. Tests therefore assert on *bounds* (`hours*min ≤ Δ ≤ hours*max`)
  rather than exact figures.

### 5.4 `GET /api/bullets/shop` (new route)

`accessInJail` may stay at the default `true` — it is a read. Calls
`restockIfDue`, then returns the acting player's current location row:

```json
{ "locationId": "...", "locationName": "...", "bulletStock": 41234,
  "unitCost": "7", "maxBuy": 500, "bullets": "120" }
```

`unitCost` is the **effective** price — `min(lever ?? location.bulletCost, max_cost)`,
or the unclamped price when `max_cost` is unset — which is exactly what the buy
route will charge. It is money, so it crosses the wire as a decimal string;
`bulletStock` is a count and stays a JSON number, as it already does in the buy
response. `maxBuy` is a count too, and is `null` when unlimited. No location →
409 `no_location`, matching the buy route.

### 5.5 Buy route changes (`index.ts`)

- `max_buy`: `quantity > maxBuy` → `PluginError("quantity_above_max", 400, { maxBuy })`,
  checked before any lock.
- `max_cost`: `unitCost = min(franchise?.lever ?? location.bulletCost, maxCost)`
  at line 140. Everything downstream (the owner's half, the ledger row, the
  event) follows from the clamped figure.
- Lock order is unchanged, and the buy route deliberately does **not** call
  `restockIfDue` — it would make a purchase take every location row lock. The
  shop GET is the sole trigger. Accepted consequence: an API-only client that
  never reads the shop never fires a restock. The web client always does.

### 5.6 The lever cap (`properties` + `bullets`)

- `properties` exports a new point,
  `export const leverSet = filterPoint<LeverSet>("properties.leverSet")`, and
  `leverRoute` (`properties/src/index.ts:264`) applies it **before** opening its
  transaction — filters cannot join the caller's write
  (`filters.ts:79`). Payload: `{ propertyTypeId, value, playerId }`.
  The existing `LEVER_FLOOR` guard is untouched.
- `bullets` subscribes with `on(leverSet, ...)`, ignores every
  `propertyTypeId !== "bullets"`, reads `bullets.max_cost` through its own
  transaction (§3.5), and throws
  `PluginError("lever_above_cap", 400, { maxCost })` when exceeded. Returns the
  value unchanged otherwise — this filter rejects, it never transforms.
- `bullets` already depends on `@gl3/plugin-properties` for `ownerAt` / `payOwner`,
  so no new dependency edge appears. This is the third live filter consumer
  after `bounties → combat` and `casino.games`.
- The cap being a boot snapshot means nothing can change it between the
  filter's check and properties' write.

### 5.7 Admin surface (`bullets`)

Two panels on the existing `/admin/bullets` page:

- **Options** (new) — `GET`/`POST /api/admin/bullets/options`, auth `"admin"`,
  writing the five `bullets.*` rows via upsert. The form carries a visible note
  that changes apply after a server restart (§3.2). An empty `max_cost` /
  `max_buy` field is stored as an empty-string row rather than deleted, so the
  form round-trips; the parser in §5.1 treats an empty, absent or unparseable
  value for those two identically, as unlimited — there is no third state.
- **Stock** (existing, kept) — the per-location table and form.
  `bulletStock` is validated `≤ max_stock` and `bulletCost` `≤ max_cost`,
  answering 400 rather than silently clamping.

Both paths sit under the already-claimed `/api/admin/bullets` base path and
declare `auth: "admin"`, as the loader requires. No UUID is rendered in either
table (`test/admin-ids-hidden.test.ts` enforces this); ids continue to travel as
the select's `valueKey`.

### 5.8 Web (`apps/web`)

- `@gl3/shared` gains `BulletShopResponseSchema` in `dto/bullets.ts` —
  additive, so **`0.1.6` → `0.1.7`, published**. `@gl3/plugin-sdk` is unchanged;
  both plugin packages are `private: true` and need no version move.
- `keys.bulletShop()` in `api/keys.ts`; `useBulletShop()` in `api/queries.ts`.
- `Bullets.tsx` reads stock, name and price from the new hook instead of
  `useLocations()`, and enforces `maxBuy` client-side alongside the existing
  affordability check.
- `useBuyBullets`'s `onSuccess` invalidates `keys.bulletShop()` as well as
  `keys.me()` and `keys.locations()`, and `ws/invalidation.ts` maps the
  `bullets` tag to the new key so a purchase refreshes the shop.
- No new `GameEvent` variant: a restock publishes nothing. So none of the four
  places a variant must reach is touched.

## 6. Testing

Integration against real Postgres and Redis, no mocks. Every new file must be
added to `vitest.workspace.ts`'s explicit `include` — the ninth registration
site, invisible when missed.

`apps/server/test/bullets-restock.test.ts` (default `@gl3/server` project):

- 3 hours due → every location's stock rises by `[3*min, 3*max]`
- 30 hours due → rise is `≤ 12*max` (the clamp)
- 0 hours due → no row changes and the cursor does not move
- `max_stock` clamp — a location seeded above the max ends *at* the max
- the cursor lands exactly on `date_trunc('hour', now())`
- garbage settings (`min > max`, negative, non-numeric, absent) restock without
  throwing
- **concurrency**: N parallel `GET /api/bullets/shop` when due produce exactly
  one restock — total Δ stays inside a single draw's bounds
- per-location independence: with three locations seeded, **each** location's Δ
  is independently inside `[hours*min, hours*max]`. The assertion is
  deliberately *not* "their draws differ" — two independent draws can legally
  collide, and a test that fails on a legal outcome is flaky, which in this repo
  means broken.

`apps/server/test/bullets-restock-lock-order.test.ts` (default project): restock
against travel, ABBA. Per the RULE 6 corollary, participants must **not** all
acquire through the same helper, and the test must be demonstrated red against
a descending-order variant before it counts.

`apps/server/test/bullets.test.ts` (extended): `max_buy` rejection, the
`max_cost` clamp on both the lever path and the location path, and the shop
route's effective-price answer for an owned versus unowned town.

`apps/server/test/bullets-admin.test.ts` (new or extended): options round-trip
writes the five rows; the stock form rejects above-cap values.

`apps/migrate/test/...`: the rename map — a V2 fixture with the six flat keys
lands the six namespaced keys, and re-running is idempotent. Needs
`MYSQL_ADMIN_URL` exported alongside `DATABASE_URL` and `REDIS_URL`.

The lever-cap filter gets a test proving a subscriber `PluginError` surfaces as
a 400 from `POST /api/properties/:id/lever`.

## 7. What this does not touch

No new tables and no new columns, so no plugin migration and no core migration —
`apps/server/test/schema.test.ts`'s FK and index counts are untouched. No new
`GameEvent` variant. No new plugin package, so none of the eight workspace
registration sites apply. `@gl3/plugin-sdk` keeps its surface and its version.

The merge gate is a bare `npm run verify`, exit code read from the process — not
from a wrapper, and not through a pipe.
