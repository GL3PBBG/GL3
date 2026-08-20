# Premium membership — design

Date: 2026-08-20. Status: approved for planning.

## What this is

V2's `membership` module, ported and improved: a timed premium status bought
with **points**, granting gameplay benefits while active. Read from V2 source
(`github.com/ChristopherDay/Gangster-Legends-V2`, `master`,
`modules/installed/membership/*` plus the three consumer `*.hooks.php` files),
so this is a port with a real behaviour record, not a from-spec invention.

V2 mechanics, kept exactly:

- Packages: description, cost in points, duration in seconds
  (`premiumMembership` table: `PM_id`, `PM_desc`, `PM_cost`, `PM_seconds`).
- Buy: points deducted, membership timer extends from
  `max(now, current expiry) + duration` — stacking, never wasteful.
- Benefits are **consumer-owned**: the module that owns the affected number
  applies the effect and declares the display copy. V2 stock benefits:
  - crimes: cooldown `ceil(cooldown × 0.75)` — "Getaway Driver"
  - theft: success chance `floor(chance × 1.1)`, capped at 100 — "Slide Hammer"
  - travel: cost `ceil(cost × 0.25)` — "Frequent Flyer Discount"
- Page: benefit list + package list + expiry display.
- Admin: package CRUD.

Improvements over V2 (user-selected):

1. **Benefit registry** — a filter point any plugin can subscribe to declare
   its benefit's display copy; effects stay consumer-owned. Third-party
   marketplace plugins can add benefits with zero SDK surface.
2. **Expiry notification** — lazy, no cron: the first membership check after
   expiry notifies the player.
3. **Gifting** — buy a package for another player by name.

Deliberately NOT in scope: tiered memberships (packages differing in benefit
sets, not just duration) — rejected at design time; V2's two cosmetic settings
(`membershipLinkName`, `membershipName`) — they fed V2 template labels that
have no GL3 equivalent (the page title is static manifest data); making the
three benefit magnitudes admin-editable (hardcoded constants, V2 parity).

## Shape and ownership

`@gl3/plugin-membership` — the **20th** plugin, the **10th** to own tables and
migrations.

- Owns `p_membership_packages` (plugin migration `0001`):
  `id uuid PK`, `name text`, `cost_points bigint`, `duration_seconds int`.
  **No foreign keys** — like `p_inventory_shop_stock`, it adds no lock-graph
  edge, so there is no new lock-order test and `schema.test.ts` is untouched
  (no core migration at all in this cluster).
- Membership **status** is NOT a plugin table: it is the core `player_timers`
  row with key `membership`, which M4 already migrates from V2 `userTimers`
  verbatim. This cluster makes those migrated-but-unread rows live — the
  money-ranks pattern. Zero data movement; the status of every migrated V2
  member is correct on day one.

## SDK: `tx.timers`

New on `PluginTx`, additive:

```ts
readonly timers: {
  get(playerId: string, key: string): Promise<Date | null>;
  set(playerId: string, key: string, expiresAt: Date): Promise<void>;  // upsert
  clear(playerId: string, key: string): Promise<void>;
};
```

Generic by design — it mirrors V2's open-ended `userTimers` (custom V2 modules
used arbitrary keys, and those rows are already migrated), so any future
plugin gets per-player timers without owning a table.

**Rule-6 note:** the `player_timers` upsert takes `FOR KEY SHARE` on the
`players` row via its FK. Every write path in this cluster locks the affected
player `FOR UPDATE` first (buy: `applyBalanceChange`'s internal lock; gift:
`tx.locks.player([buyer, recipient])`), so the KEY SHARE nests under an
already-held stronger lock and no new edge appears.

## Routes

All under `/api/membership`, all `auth: "user"` unless noted.

- `GET /api/membership/status` → `{ active, expiresAt | null }` (one-row table
  source for the page).
- `GET /api/membership/packages` → package list (id as `valueKey` only, never
  displayed).
- `GET /api/membership/benefits` → the collected benefit registry (below).
- `POST /api/membership/buy` `{ packageId }` — one transaction:
  `applyBalanceChange(points, −cost)` (locks buyer), then
  `timers.set("membership", max(now, current) + duration)`. 400
  `package_not_found`, 400 `insufficient_points` (ledger's insufficient-funds
  error mapped). Publishes plugin event `membership.purchased` with
  `invalidates: ["membership", "me"]` after commit.
- `POST /api/membership/gift` `{ packageId, recipientName }` — resolve
  recipient by name (404 `player_not_found`), 400 `cannot_gift_self`; one
  transaction: `tx.locks.player([buyer, recipient])` FIRST (sorted — the
  existing player↔player edge combat owns; no new lock-order test, recorded
  here as deliberate), buyer pays, recipient's timer extends by the same
  stacking rule, `tx.notify(recipient, ...)`. Plugin event `membership.gifted`
  to both audiences, `invalidates: ["membership", "me"]`.

Admin (loader tier `auth: "admin"`, `hasPermission("membership")`):
`GET /api/admin/membership/packages`, `POST .../packages/create`,
`POST .../packages/update`, `POST .../packages/delete`. Declared as
`adminPages` table + forms; **no UUID rendered** (ids travel only as select
`valueKey`s — `admin-ids-hidden` floor rises by one section).

## Exports (cross-plugin surface)

From `@gl3/plugin-membership`, the `properties`/`detectives` export shape:

```ts
export const MEMBERSHIP_TIMER_KEY = "membership";
export async function membershipUntil(tx: PluginTx, playerId: string): Promise<Date | null>;
export async function isMember(tx: PluginTx, playerId: string): Promise<boolean>;
export interface BenefitDecl { title: string; description: string }
export const benefits: FilterPoint<BenefitDecl[]>;  // "membership.benefits"
```

`isMember` is also the **lazy expiry notifier**: if the timer row exists and
is expired, it deletes the row and `tx.notify`s "your membership has expired"
in the caller's transaction, then returns false. Row absence = already
notified — the DELETE is the atomic claim, no Redis marker, no check-then-act
(rule 2 satisfied structurally). The delete touches only the timer row (no FK
lock on players from a DELETE), so it is safe inside any consumer's
transaction. Coverage comes from consumer traffic: crimes, theft and travel
all call `isMember` on their hot paths.

## Benefit registry

`membership` declares `benefits = filterPoint<BenefitDecl[]>("membership.benefits")`
— the `casino.games` shape: an extension point costing no SDK surface. The
`GET /api/membership/benefits` route applies the filter over `[]` and returns
the accumulated list. Subscribers append display copy only; **effects stay in
the consumer's own code** (V2's own architecture). Subscribers must not read
their own settings namespace (`runFilterChain` passes the applying plugin's
ctx — the mislabelling trap, on record twice).

## Consumers — three new dependency edges (6th–8th)

`crimes → membership`, `travel → membership`, `theft → membership` (after
`bounties→combat`, `combat→inventory`, `bullets→properties`, `bullets→travel`,
`combat→detectives`). Each consumer:

1. subscribes to `membership.benefits` with its V2 display copy, and
2. calls `isMember(tx, playerId)` and applies its hardcoded multiplier at BOTH
   the acting route and the listing route (so the page shows the discounted
   number the action will actually use):
   - crimes: `cooldownSeconds = ceil(base × 0.75)` at `ctx.cooldown.acquire`
     and in the listing DTO.
   - travel: `cost = ceil(base × 0.25)` at charge and in the listing DTO.
   - theft: `chance = min(100, floor(base × 1.1))` at steal and in the tier
     listing.

A deployment that loads a consumer without loading `membership` still works:
`isMember` reads core `player_timers` through the SDK, so it answers `false`
for everyone (no rows say otherwise) and the filter point simply never serves
a page. The package dependency ships built `dist/` like any other.

## Events

Plugin events only (`tx.events.publish`) — **no core `GameEvent` widening**,
so none of the four places a new variant touches (eventCopy, invalidation,
CORPUS, shared census) changes, and `@gl3/shared` needs no event work.

## Shared DTOs and versions

**Amended post-planning (drift found during implementation):** no
`dto/membership.ts` shipped and `@gl3/shared` is **untouched** by this
cluster. The status/packages/benefits pages are manifest-declared views over
generic `{ rows }` tables (the theft precedent — a manifest page needs no
shared response schema unless it is hand-written `apps/web`, and `/membership`
is not), so there was never a shaped DTO for this cluster to add. By the time
this cluster landed, `@gl3/shared` had already moved past the `0.1.14`
baseline this section originally planned against; it stays wherever other
work has since left it (`0.1.16` at the time of writing) with no bump from
membership.

- `@gl3/plugin-sdk`: `tx.timers` is the only SDK surface this cluster adds.
  Bumped `0.1.9` (unpublished, already ahead of this section's original
  `0.1.7` baseline — other work landed in between) to **`0.1.10`**, additive,
  unpublished pending the user's approval — publish only after a registry
  check (`npm view @gl3/plugin-sdk versions --registry https://npm.gl3.dev`),
  per the repeated another-session-took-the-number incident.

## M4

New migrator: V2 `premiumMembership` → `p_membership_packages` (id via
`id_map` UUIDv7, `PM_desc` → `name`, `PM_cost` → `cost_points`,
`PM_seconds` → `duration_seconds`). Fixture DDL gains the table; the
idempotency census gains one target table. The `membership` userTimer rows
are already handled by the existing timers migrator — no change there. V2's
`membershipLinkName`/`membershipName` settings are report-skipped.

**Fixture defect found and fixed on this branch** (the `PR_owner` defect
class — see the properties-franchise cluster): `apps/migrate`'s test fixture
DDL for `premiumMembership` declared the description column as `PM_name`.
Real V2 (`modules/installed/membership/*`) names it `PM_desc`, matching what
this section already specified above. The fixture, not the spec or the
migrator, was wrong; it is fixed in `apps/migrate/test/fixtures` on this
branch.

## Web

`/membership` is **manifest-declared** (theft precedent, not the hand-written
properties exception): panel with a status table (`GET .../status`), a
benefits table (`GET .../benefits`), a packages table (`GET .../packages`),
a buy form (select over packages), and a gift form (select over packages +
`type: "text"` recipient-name field — the basic field branch already exists
in `ViewNodeSchema`, no vocabulary change). No live countdown (the view
vocabulary has none); the status row shows the expiry timestamp. Menu entry
under the points area, order after bank.

## Tests

- Plugin: buy (stacking from live expiry AND from expired/absent), insufficient
  points, package CRUD + admin ids hidden, gift (recipient timer extends,
  notify row, self-gift 400, unknown name 404), expiry lazy path (expired row
  → one notification, second call → no second notification, row gone).
- Consumers: each of the three — member vs non-member number in both the
  listing and the act (crimes cooldown actually shorter via `cooldown.peek`,
  travel charged less via ledger row, theft chance clamp at 100).
- Lock order: NO new test — gift uses `tx.locks.player`, the existing sorted
  player↔player helper; a test whose participants share the helper proves only
  the already-safe case (CLAUDE.md rule-6 corollary).
- M4: migrator unit + census updates.
- Every new test file registered in `vitest.workspace.ts` includes (ninth
  registration site); all eight workspace-plugin registration sites for the
  new package, including the 5 `Dockerfile.server` COPY lines
  (`grep -c "packages/plugins/membership" Dockerfile.server` → 5).

## Risks

- `isMember` writes (DELETE + notification INSERT) inside consumer read
  transactions: kept minimal and self-serializing; the DELETE is idempotent
  under concurrency (second deleter deletes zero rows → must then NOT notify
  — implement as `DELETE ... RETURNING` and notify only on a returned row).
- Consumer listing routes must apply the same multiplier as the act, or the
  page lies; tests pin both sides.
- Registry publish race with concurrent sessions: check `npm.gl3.dev` before
  bumping/publishing, per the social-cluster incident.
