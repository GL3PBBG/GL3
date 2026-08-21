# Extension Surface Expansion — Design

Date: 2026-08-20
Status: approved in brainstorming; awaiting implementation plan
Branch: worktree `feat-extension-surface` (another agent owns the main checkout)

## Problem

V2 registers 43 hook names (accountMenu, profileStat, itemActionLink,
equipSlot, currencyFormat, alterGlobalTemplate, …). A third-party V2 module
injects into menus, profiles and item UIs anywhere on the page. GL3 has five
filter points — `combat.killResolved`, `casino.games`, `membership.benefits`,
`properties.leverSet`, `travel.locationsListed` — all data-level, all owned by
plugins, none touching UI. A plugin author coming from V2 feels this gap
first: there is no way to put anything on a page the plugin does not own.

Hook-name parity is not the goal. V2's 43 names collapse into five capability
classes:

1. Nav/menu injection (menu entries exist; badges and grouping do not)
2. Core-page augmentation (profileStat: rows/actions on /profile, dashboard, HUD)
3. Cross-plugin entity augmentation (itemActionLink/equipSlot: inject into
   inventory's item UI)
4. Formatting hooks (currencyFormat)
5. Template rewrite (alterGlobalTemplate)

**Scope (user-approved): classes 1–4, plus GL3-native extras. Class 5 is
excluded** — it cannot be typed and conflicts with the marketplace trust
model (hand-audited typed manifests, no arbitrary client code).

## Approach (chosen: A)

Grow the one extension mechanism GL3 already has — typed `FilterPoint` +
`on()` + manifest `filters` — into core. Core declares its own filter points
at DTO-assembly seams; plugins subscribe exactly the way they already
subscribe to `casino.games`. Subscribers return typed view fragments,
validated by shared zod schemas, merged server-side (one request per page, no
client fan-out), rendered generically by the web app.

Rejected: (B) a parallel "contributions" subsystem — a second mechanism to
learn, audit, validate and invalidate, for isolation that buys nothing since
filters already run outside transactions; (C) client-composed static
contributions with per-contribution fetches — N requests per page and the
weakest parity (no server-computed per-target data).

## Section 1 — SDK mechanics

### 1a. Per-subscriber ctx (trap fix)

`runFilterChain` today passes the **applying** plugin's ctx to every
subscriber. That trap is on record twice: a `combat.killResolved` subscriber's
`tx.events.publish` would be mislabelled as combat's (properties seizure uses
`tx.notify` to dodge it), and a `properties.leverSet` subscriber cannot read
its own settings namespace (bullets works around it). With ten times more
subscribers the trap scales; fix it now.

- Loader stamps each manifest's `filters` entries with the owning plugin's id
  at load time: `BoundSubscription { sub: FilterSubscription, ownerId: string }`.
  `on()` is unchanged.
- `runFilterChain` is changed **in place** (no parallel function, no
  deprecated original): it takes the bound subscriptions and a **ctx
  factory** — `ctxFor(ownerId) => PluginCtx` — instead of a single ctx, and
  builds each subscriber its own plugin's ctx (events labelled correctly,
  own settings namespace, own cooldown/asset scopes). One function, one
  signature; its single caller (`apps/server/src/plugins/ctx.ts`) is updated
  with it. See "Compatibility regime" below for why breaking the signature
  is free.
- Existing 8 subscriber edges only relax: the existing workarounds keep
  working (detectives' expire-at-hire is data design, untouched; bullets'
  lever clamp-at-charge stays correct).
- Red-first test: a subscriber that publishes an event / reads its settings
  is shown wrong under the old binding before the fix lands.

### 1b. Core-owned filter points

Plugins cannot import from `apps/server` (dependency direction) and core has
no manifest, so core point tokens live in **`@gl3/plugin-sdk`**: new module
`packages/plugin-sdk/src/core-points.ts` exporting the typed tokens. Value
schemas live in **`@gl3/shared`** (the client parses them off the wire); the
SDK already depends on shared. The whole core surface is therefore
enumerable from SDK docs — marketplace documentation for free.

### 1c. Failure policy on the point

A throwing subscriber today propagates — correct for data points (a broken
payout filter must not half-apply), wrong for UI seams (one bad plugin would
500 /profile for every player). The policy belongs to the **point**, chosen
by its owner, so `filterPoint`'s signature changes in place:

```ts
filterPoint<T>(name: string, policy: "propagate" | "collect"): FilterPoint<T>
```

Required second argument, no options bag, no overload. `"collect"` wraps
each subscriber in try/catch — a failed contribution is dropped and logged,
the chain continues. `runFilterChain` reads the policy off the point. The
five existing declarations gain an explicit `"propagate"`; the UI seams
declare `"collect"`. This generalizes casino's game-throw→400 precedent.

### Point-name convention, enforced

The five existing points already follow `<ownerId>.<suffix>` (verified —
declarer matches prefix in all five), so no rename is needed. What the free-
breakage window buys instead: `validatePlugins` now **enforces** that a
plugin's declared point names are prefixed with its own id, and reserves the
`core.` prefix for SDK-declared core points. After a real release this
enforcement would be unaddable without breaking any nonconforming plugin;
adding it now costs nothing.

### Retired legacy: duck-type arm in error guards

`isPluginError` and its three siblings (`packages/plugin-sdk/src/errors.ts`)
each accept the `Symbol.for` brand **or** a `name`+shape duck-type kept for
"plugins published against 0.1.0–0.1.8". No such plugin exists, so the arm
defends nobody and is the one branch that lets an unrelated error named
`PluginError` through if it happens to carry `code` and `status`. Delete
`named()` and the four fallback arms, plus the tests pinning the legacy
behaviour (`error-guards.test.ts`'s unbranded-copy case and its siblings).
Brand-only is stricter and survives duplicate SDK copies (`Symbol.for` is
process-global), which is the only property the boundary needs. Folded into
this branch per the touch-the-SDK-next rule.

### Compatibility regime (decision)

`@gl3/shared` and `@gl3/plugin-sdk` have **no external consumers**: every
in-repo consumer resolves through the workspace (`"*"`), and no third-party
plugin exists. Until one does, CLAUDE.md's additive-only discipline protects
nothing and costs the ability to fix shapes while fixing them is free. So:

- Breaking changes to both packages are **authorized on this branch** and
  ship without ceremony (version numbers still move; chosen at publish time
  after a registry check, as always).
- **The event that ends this regime is the first third-party plugin author —
  not the first npm publish.** From that point CLAUDE.md's discipline is
  correct again and mandatory. This decision is recorded here and in
  `docs/STATUS.md` when this branch lands.

### 1d. Explicit non-changes

No new tables, no migrations, no new lock-graph edges (every seam read is a
plain SELECT outside any transaction — the existing filter rule), and no new
`GameEvent` variants — none of the four places a variant touches changes.
`schema.test.ts` counts are untouched. No lock-order test is added because
no edge is added (the location-combat-modes precedent: record it so nobody
hunts for one).

## Section 2 — Seam catalogue

Core-owned points (tokens in SDK, applied by core routes, schemas in shared):

| Point | Value `T` | Applied at | Rendered |
|---|---|---|---|
| `core.profileView` | `{ targetId, extras: ProfileExtra[] }`; extra = stat `{label, value}` \| link `{label, to}` | profile route after DTO assembly; `extras` new optional field on `ProfileDto` | Profile.tsx appends rows and action links generically |
| `core.dashboard` | `DashboardWidget[]` = `{ title, view: ViewNode }` | new route `GET /api/dashboard/widgets` (dashboard has no data route today — it composes existing queries client-side) | rendered via existing `renderNode` — full view vocabulary available |
| `core.hud` | `HudEntry[]` = `{ label, value, countdownTo? }` | new route `GET /api/hud/extras` | Shell appends `<Stat>` entries; `countdownTo` ticks client-side |
| `core.menuBadges` | `{ path, count }[]` — `path` is the nav link target (`"/detectives"`, `"/plugins/x"`), so one shape covers core and plugin links | new route `GET /api/menu/badges` | badge on any nav link, same styling as mail/notifications |
| `core.moneyFormat` | `MoneyFormat { symbol, position, thousandsSep }` | `/api/plugins` payload build, per request | `Money`/`Amount` components consume — currencyFormat parity, declarative |

Plugin-owned new point:

- `inventory.itemActions` — `{ items: ItemActionCtx[] }`; subscribers append
  `{ itemId, label, to }` links per item. Applied in inventory's list route,
  rendered as per-row action links. itemActionLink/equipSlot parity (equip
  itself is already inventory-native).

Notes:

- Every extra carries `pluginId` for attribution, set by the subscriber as
  `ctx.pluginId` — which, under per-subscriber ctx binding (1a), is the
  owner's id by construction. A generic `runFilterChain` cannot stamp
  entries inside an arbitrary `T`, and the marketplace trust model is
  hand-audit, not runtime enforcement, so convention plus audit is the
  design. (`PluginCtx` gains `readonly pluginId` if it does not already
  expose it.)
- **Links are the v1 action verb.** V2's hooks injected links; direct POST
  buttons from injected UI need an action-routing story and are deferred.
- All new DTO fields are optional → additive shared bump.
- Invalidation: new query keys `hudExtras`, `menuBadges` in `api/keys.ts`
  join the existing WS invalidation map; plugin events' `invalidates` lists
  can name them.

## Section 3 — Retrofits (acceptance), versioning, testing

### Retrofits — real consumers, one per seam

| Plugin | Seam | Contribution |
|---|---|---|
| bounties | `core.profileView` | stat "Open bounty: $X" + link "Place bounty" (page prefills target via query param) |
| detectives | `core.profileView` | link "Hire detective" |
| membership | `core.hud`, `core.profileView` | membership countdown entry; "Member" stat |
| crimes | `core.dashboard` | next-crime-ready widget |
| combat | `inventory.itemActions` | "Repair at gunsmith" link on weapon rows (gunsmith is combat's route; today undiscoverable from inventory) |
| detectives | `core.menuBadges` | ready-report count on "/detectives" (searches past `ends_at`, not expired — plain SELECT, no new table) |
| — | `core.moneyFormat` | no natural existing consumer; integration-test subscriber + SDK docs example |

Dependency edges: **zero new plugin→plugin edges.** Core-point subscribers
import tokens from the SDK, not from another plugin. `combat→inventory`
already exists (unchanged). The surface grows without coupling growth.

### Versioning / publishing

- `@gl3/shared`: extras fields, `MoneyFormat`, hud/badge DTOs (additive as it
  happens, but additivity is no longer a constraint — see Compatibility
  regime).
- `@gl3/plugin-sdk`: `core-points.ts`, `BoundSubscription`, plus the
  **breaking** in-place signature changes (`filterPoint` policy arg,
  `runFilterChain` ctx factory) and the error-guard legacy-arm deletion —
  authorized under the regime.
- Exact version numbers chosen **at publish time after a registry check**
  (0.1.12/0.1.14 pending-publish collisions with concurrent sessions are on
  record). Publishing needs the user's explicit approval, per standing rule.

### Testing

- SDK unit: per-subscriber ctx binding (red first under the old binding);
  collecting chain drops a throwing subscriber and continues.
- Integration per seam: a subscriber's contribution appears in the DTO; a
  throwing subscriber is dropped and the page still answers 200.
- `view-node-parity.test.ts` untouched — no new view-node kinds
  (`core.dashboard` reuses the existing vocabulary).
- Every new `apps/server/test/*.test.ts` file registered in
  `vitest.workspace.ts` `include` (the ninth registration site — bit three
  tasks on feat/car-theft).
- Merge gate: bare `npm run verify` in this worktree, exit code read from the
  process, after checking `pgrep -fa vitest` and
  `select datname from pg_database where datname like 'gl3_tmpl%'` for
  concurrent runs (cross-talk makes a run void, not failing).

### Deferred (recorded, out of v1)

Template rewrite (class 5), POST buttons from injected UI, target-list
augmentation, player-facing settings slot, and a forum new-posts badge —
that last because "unread" requires a per-player read-tracking table and
this branch ships no migrations.
