# Admin pages + ABAC authorization — design

Date: 2026-08-13
Status: approved (design review in chat, 2026-08-13)

## Goal

An admin area for GL3: the first player ever registered becomes admin
automatically, and administrators can manage game content — add towns, fill
the shop, manage bullet stock, edit crimes and ranks, post news — plus
minimal role management.

**Governing constraint (set by the user):** admin features are contributed by
plugins. If a plugin is not loaded, its admin section, routes, and grants do
not exist. This mirrors V2's per-module `<name>.admin.php`.

Authorization takes inspiration from the user's ABAC gist
(<https://gist.github.com/rondlite/d24e27edd7b5cf9dc67482b23176da73>):
deny-by-default, a uniform `hasPermission` check, and a type that leaves room
for predicate (data-dependent) checks. V1 implements only the boolean level;
the predicate slot is documented as future, not plumbed.

## Decisions (with the review that produced them)

1. **DB-driven grants, not a code-keyed role union.** An earlier draft keyed a
   code policy map by role-name union. Review of the existing code found
   `packages/plugins/news/src/index.ts:53-68` already gates news posting by
   reading `role_module_access` (V2-ported: `moduleKey === "news" || "*"`),
   with tests covering granular denial. The design therefore generalizes that
   exact model instead of introducing a second source of truth:
   - `roles` rows are the roles; `role_module_access` rows are the grants.
   - A route requiring admin passes when the player's role has a grant for
     the **declaring plugin's manifest id** or the `*` wildcard.
   - No free-form resource strings, no policy-fragment merging.
2. **Declarative admin UI via the SDK page vocabulary**, not bespoke React per
   plugin. One new node kind (`table`) is added — see §SDK. Bespoke React per
   plugin section was rejected because it breaks plugin self-containment; a
   single all-knowing `admin` plugin was rejected for the same reason.
3. **V1 scope:** all six plugin sections (travel towns, bullets, inventory
   items + shop, news, crimes, ranks) plus minimal core role management.
4. **Deletes are out of scope for v1** (cascade questions: towns with players
   in them, items in inventories). Editing covers the operational need.

## Data model

**No new tables, no new columns.**

- `roles` (id, name, color) and `players.roleId` — already in
  `apps/server/src/db/schema/identity.ts` — carry player → role.
- `role_module_access` (roleId, moduleKey) carries role → grants. `*` is the
  V2-preserved admin wildcard.
- First registration seeds a role named `Administrator` with one
  `role_module_access` row (`*`) and assigns it to the new player.

## Authz core

New module `packages/plugin-sdk/src/authz.ts`:

```ts
/** True when grants contain the module key or the `*` wildcard. */
export function hasPermission(grants: readonly string[], moduleKey: string): boolean;
```

- Deny-by-default: no role → no grants → false; unknown module key → false.
- The gist's predicate slot (`boolean | (user, data) => boolean`) is
  documented in this module's comments as the future extension point for
  data-dependent checks. V1 ships no predicate and no plumbing for one
  (YAGNI — every v1 check is a boolean grant).
- This one function is used by both the plugin loader's route gate and core's
  admin routes. There is no second implementation.

`role_module_access` therefore remains live at runtime (it already was, via
the news gate). `docs/ENGINEERING-NOTES.md` gets a paragraph stating that
GL3 authorization is: role → module grants → `hasPermission`, and that the
gist's predicate level is future.

## First user = admin

Inside the existing registration transaction
(`apps/server/src/auth/routes.ts`, `POST /api/auth/register`):

1. `SELECT pg_advisory_xact_lock(<constant key>)`.
2. Insert `players` + `player_stats` rows (as today).
3. `SELECT count(*) FROM players`; if the count is 1 (the row just inserted
   is the only one), upsert the `Administrator` role (stable name; insert
   `roles` + `role_module_access('*')` if absent) and set the new player's
   `roleId`.

The advisory lock is load-bearing: under read committed, two concurrent
first registrations each see only their own insert — both would count 1 and
both would claim admin. The lock serializes the count-and-claim. A
concurrency test must demonstrate exactly one admin from parallel first
registrations, and must be shown failing without the lock.

## SDK surface changes

All three additions are backwards-compatible; no existing plugin changes
except `news` (below).

### 1. Route auth: `"admin"`

`RouteDef.auth` widens from `"player" | "public"` to
`"player" | "public" | "admin"`.

Loader behaviour for `"admin"`: authenticate the session as for `"player"`,
then resolve the player's grants (one indexed join:
`players.roleId → role_module_access`) and require
`hasPermission(grants, manifest.id)`. Failure → `403 { error: "forbidden" }`.
401 stays reserved for missing/invalid token. No caching of grants in Redis
for v1 — admin traffic is tiny and revocation is immediate.

`accessInJail` / `accessInHospital` defaults (`true`) are correct for admin
routes: a jailed admin can still administrate.

**Boot-time rule (closes the gate-bypass-by-omission class):** any plugin
route whose path starts with `/api/admin/` MUST declare `auth: "admin"`;
manifest validation rejects the plugin at boot otherwise.

### 2. Manifest field: `adminPages`

`PluginManifest` gains `adminPages: PageSchema[]` (default `[]`), validated
by the existing `PageSchemaSchema` + bounds check at boot, plus one extra
rule: an admin page's `path` must start with `/admin/`.

A separate field — not a flag on `pages` — because the public manifest
endpoint must not leak admin views: `buildPluginsPayload` ignores
`adminPages` entirely. Admin sections are served only by
`GET /api/admin/plugins` (core, below), filtered per requester.

### 3. One new leaf node kind: `table`

```ts
{ kind: "table",
  source: string,          // "GET /absolute/path", VIEW_ACTION_RE-style
  columns: { key: string; label: string }[] }
```

The web renderer fetches `source` on mount and expects
`{ rows: Record<string, string>[] }` — zod-parsed client-side, values
pre-stringified server-side (money as decimal string, as everywhere).
Columns render in declared order.

This is the one vocabulary growth. Justification recorded in `pages.ts`'s
"does not grow" comment (which is updated to name `table` and restate the
bar): admin pages need live data, and plugin-contributed pages cannot take
bespoke React overrides without breaking plugin self-containment. `source`
routes are ordinary plugin routes declared with `auth: "admin"`, so table
data is guarded even when the URL is hit directly.

**Accepted v1 limitation — edit-by-id:** views are static, so editing an
existing row means the table shows an `id` column and the edit form has a
text `id` field the admin pastes into. Per-row action buttons are the v2
upgrade path if this hurts in practice.

## News gate replacement

`packages/plugins/news`'s post route switches to `auth: "admin"` and its
inline transaction gate (role lookup + `role_module_access` scan) is deleted.
Its three existing gate tests (no role denies; a role granting a different
module denies; `*` allows) are reworked to exercise the loader gate — the
granular case stays meaningful: a role granting only `news` can post news but
cannot touch travel admin.

## Per-plugin admin sections (v1)

Each lives in its existing plugin package: `adminPages` entries plus admin
routes with `auth: "admin"`. Every mutation body and every route param is
zod-validated. List (table-source) routes are also `auth: "admin"`. No new
plugin packages, so the eight-registration-site checklist and Dockerfile do
not apply.

| Plugin | Admin page content | Routes |
|---|---|---|
| travel | Towns table (id, name, travel cost, cooldown); add-town form; edit form (by id) | `GET /api/admin/travel/locations`; `POST /api/admin/travel/locations` (create); `POST /api/admin/travel/locations/update` |
| bullets | Table (id, town, stock, price); set form (id, stock, price) | `GET /api/admin/bullets/stock`; `POST /api/admin/bullets/stock` |
| inventory | Items panel: items table + create-item form. Shop panel: stock table (town, item, price, stock) + stock form (locationId, itemId, price, stock) | `GET/POST /api/admin/inventory/items`; `GET/POST /api/admin/inventory/shop` |
| news | Post form (title, body); recent-news table | existing post route (auth switched); `GET /api/admin/news` |
| crimes | Crimes table; edit form (id, cooldown, min/max payout, min/max bullets, exp, minRank, jail chance/seconds) | `GET /api/admin/crimes`; `POST /api/admin/crimes/update` |
| ranks | Ranks table; edit form (id, name, expRequired, cashReward, bulletReward, maxHealth) | `GET /api/admin/ranks`; `POST /api/admin/ranks/update` |

Implementation notes that came out of review:

- **Item effects.** `items.effects` is jsonb. The create-item form is flat
  (`type` plus numeric stat fields); the route builds the effects object per
  `itemType`. The implementing task must read
  `packages/plugins/inventory/src/effects.ts` first and validate against the
  shape combat actually consumes.
- **Shop stock upsert.** `ON CONFLICT (location_id, item_id) DO UPDATE`.
  `p_inventory_shop_stock` has no FKs by design (documented lock-edge
  reasoning in `shop-schema.ts`); the admin route validates locationId /
  itemId existence with plain SELECTs and accepts the small race — an orphan
  row is invisible to players, which is already the documented failure mode.
- **No admin route moves a balance.** Bullet stock/price and shop stock are
  content, not money; no ledger involvement anywhere in this design.
- **No new lock edges.** All admin writes are single-row content updates;
  none holds two entity locks. The bullets admin route updates the same
  `locations` row the buy path locks FOR UPDATE, but as a single-statement
  UPDATE it participates in no ordering cycle.

## Core admin shell (`apps/server/src/admin/`)

Core Fastify routes (registered like auth's, not plugin routes), using the
same `hasPermission` helper:

- `GET /api/admin/plugins` — `{ sections }` built from loaded plugins'
  `adminPages`, **filtered to the requester's grants** (plugin id or `*`).
  A `news`-only role sees only the news section. No grants at all → 403.
  Core's role-management section is synthesized into the same payload under
  moduleKey `roles`, authored as an ordinary `PageSchema`, so the client
  renders core and plugin sections through one code path.
- Role management, guarded by grant `roles` or `*`:
  - `GET /api/admin/roles` — list roles.
  - `POST /api/admin/roles/assign` — `{ username, roleId | null }`; updates
    only `players.roleId` (single-row, no lock edges). Guard: a player
    cannot clear their own role (`cannot_demote_self`, 400) — the one
    footgun worth blocking in v1.
- Creating roles / editing grants via UI is deferred to v2.

**Session exposure:** the endpoint that backs the client's "who am I" gains
`grants: string[]` (empty when roleless). The web shows the Admin nav link
when `grants.length > 0`.

## Web (`apps/web`)

- Route `/admin` → `AdminPage.tsx`: fetches `/api/admin/plugins`, renders a
  section list (one per returned section), each through the existing
  `renderNode` / `PageRenderer` path, keyed per section id so form state and
  error banners don't bleed between sections (the bug class
  `PluginPage.tsx:40` documents).
- `render.ts` gains the `table` instruction; `PageRenderer` fetches the
  source on mount with existing `Loading` / `ErrorText` states, and
  refetches tables after any successful action on the same page, so "add
  town" immediately appears in the towns table.
- A non-admin hitting `/admin` gets the API's 403 rendered as an error
  panel. The server-side filter is the security boundary; the client hides
  nothing beyond the nav link.

## Testing

All integration tests run against real Postgres and Redis.

Authz core:

- First registration on an empty `players` table → Administrator role, `*`
  grant, `roleId` set; second registration → no role.
- Concurrency: parallel first registrations → exactly one admin. Must be
  demonstrated failing without the advisory lock.
- 401/403 matrix on an `auth: "admin"` route: no token → 401; token but no
  role → 403; role granting a different module → 403; module grant → 200;
  `*` → 200.

Manifest boundary:

- `adminPages` never appear in the public `/api/plugins` payload (leak test).
- `/api/admin/plugins` filtering: `news`-only role sees one section; `*`
  sees all; a plugin omitted from `buildApp`'s manifests contributes no
  section and no routes (the governing constraint, tested directly).
- Boot rejection: a plugin route under `/api/admin/` without
  `auth: "admin"` fails manifest validation.

Per section: one happy-path mutation with a row assert each — town
create/edit; bullet stock set, then the existing buy path reads it; item
create + shop upsert, then the public shop listing shows it; crime edit;
rank edit; role assign/clear; `cannot_demote_self`.

Renderer: `table` node boot validation (malformed `source` rejected at
load); `@gl3/web` unit tests for the table instruction and post-action
refetch.

Invariant: no admin route moves a balance, so
`test/economy-invariant.test.ts` is unaffected — stated here so a reviewer
knows it was considered rather than missed.

## Risks

1. **First-admin test isolation.** The count-based check needs an empty
   `players` table, but suite files share the database and run 6-wide. The
   implementing task must first read how existing registration tests
   isolate; if emptiness cannot be guaranteed, the check logic gets a test
   seam (injected count query) rather than a flaky table-state assumption.
   Flaky means broken.
2. **Gate bypass by omission** — closed structurally by the boot-time
   `/api/admin/` ⇒ `auth: "admin"` rule.
3. **Registration-site misses** — none: no new packages; web changes are
   in-app; Dockerfile untouched.

## Out of scope (v2 candidates)

- Predicate (data-dependent) permission checks and their plumbing.
- Role creation / grant editing UI.
- Deletes (towns, items, crimes, ranks).
- Per-row table actions in the view vocabulary.
- Grant caching in Redis.
