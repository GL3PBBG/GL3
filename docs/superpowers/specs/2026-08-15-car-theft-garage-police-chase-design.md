# Car theft, garage and the police chase — design

**Date:** 2026-08-15
**Status:** approved
**Cluster:** second of four activating migrated-but-unread V2 tables
(`cars`, `theft_tiers`, `garage`). Follows
`2026-08-15-money-ranks-backfire-weapon-condition-design.md`; precedes the
`properties` and `rounds` specs.

---

## 1. Scope

Car theft is a V2 module cluster in its own right — `cars`, `garage`, `theft`
and `policeChase` are four separate V2 modules (SPEC §1.3). This spec ships it
as **one new workspace-local plugin, `theft`**, which owns all three tables and
every route.

In scope:

- stealing a car by tier, with a weighted draw from the tier's value bracket
- the police chase on failure: escape, or jail
- a garage: list, sell, repair — all location-gated
- admin editing of the car catalogue and the tier table
- the three tables moving from core to the plugin

Out of scope, and deliberately so:

- **cars conferring any combat, travel or crime bonus.** A car is a store of
  value that decays with damage. Nothing else reads the garage.
- **garage capacity limits**, and therefore scrapping. With no cap there is
  nothing to clear, and a no-payout delete is a button whose only use is
  mistakes.
- **travel moving a car.** `garage.location_id` is where the car sits and stays
  (V2 semantics, SPEC §1.2 "cars are location-bound"). Selling or repairing
  requires standing in that city.

## 2. Table ownership

Core migration **`0008_relinquish_car_tables`** drops `cars`, `theft_tiers` and
`garage`. The `theft` plugin's own migrations create:

```
p_theft_cars(id uuid pk, name text not null, value bigint not null,
             theft_weight integer not null default 1)

p_theft_tiers(id uuid pk, name text not null, success_chance integer not null,
              max_damage integer not null,
              min_car_value bigint not null, max_car_value bigint not null)

p_theft_garage(id uuid pk,
               player_id   uuid not null references players(id) on delete cascade,
               car_id      uuid not null references p_theft_cars(id) on delete cascade,
               damage      integer not null default 0,
               location_id uuid references locations(id) on delete set null)
  index p_theft_garage_player_idx on (player_id)
```

This is the `0007_relinquish_plugin_tables` precedent applied to the next three
tables that qualify: they shipped in core `0000` only because the core schema
predated the plugin migration runner, and no core code has ever read or written
them. Foreign keys move with the tables, exactly as `bounties` and
`detective_searches` kept theirs — dropping an FK to dodge a lock edge would
change the lock graph, and §3 shows the graph is already safe.

`apps/migrate` retargets: `migrators/cars.ts` and the garage half of
`migrators/inventory.ts` import from `pg/plugin-tables.ts` instead of the core
schema. Their SQL, id-map resolution and report counters are unchanged — only
the drizzle table objects they write through move. The three-run idempotency
test's table list keeps all 26 entries; three of them are now plugin tables.

## 3. Lock order

**The load-bearing section.** CLAUDE.md rule 6: a foreign key is a lock.

Inserting a `p_theft_garage` row takes `FOR KEY SHARE` on three rows the reader
never sees named — `players`, `locations`, `p_theft_cars`. Stealing also jails
on a failed chase, which takes `player_stats` `FOR UPDATE`.

The naive order — lock the player, then insert the garage row — reaches
`locations` implicitly through `location_id` **after** holding the player. That
is the travel deadlock exactly: bullets locks location→player, so a
player→location transaction deadlocks against it under load.

**Ruling: theft locks the location first**, via the SDK's
`tx.locks.location(locationId)` — never a hand-written `SELECT ... FOR UPDATE`
— then `tx.locks.player([playerId])`. Every location↔player path in the tree
stays locations-first, and theft adds no new edge to the graph.

Which location that is has to be read before it can be locked, so the route
reads `player_stats.location_id` **unlocked** first, locks that location, then
locks the player and **re-reads** the location — the lock-then-recheck TOCTOU
defence. A player who travelled in the gap fails with `409 wrong_location`
rather than parking a car in the city they left. Selling and repairing use the
same read-lock-recheck against the car's own location.

`p_theft_cars` is a new node. Only two transactions touch it: theft, which
takes `FOR KEY SHARE` on one car row last, and the admin catalogue editor,
which takes `FOR UPDATE` on one car row and locks nothing else. A transaction
holding exactly one lock cannot be half of a deadlock cycle, so the new node
introduces none. The admin editor must keep that property: it may not grow a
second lock without revisiting this section.

`test/theft-lock-order.test.ts` proves it, and — per the CLAUDE.md corollary —
proves it against a **counterparty that does not share theft's helper**. A
concurrency test whose participants all lock through the same function proves
only the case that was already safe. The counterparties are the real bullets
purchase route and the real travel route.

## 4. Stealing

### `GET /api/theft/tiers`

Lists every tier: `id`, name, `successChance`, `maxDamage`, the value bracket,
the count of catalogue cars inside it, and `cooldownRemaining`. Read-only, no
locks, **and it does not spend the cooldown** — the combat targets-route
principle: a player must never burn an action to discover a rule.

Shaped as a `TableRowsResponse` (`{ rows: [{...strings}] }`) because it is both
the `table.source` and the `optionsSource` of the steal form's select. Ids
travel as the select's `valueKey` and are never rendered as a column, the rule
`test/admin-ids-hidden.test.ts` already enforces on the admin side.

### `POST /api/theft/steal`

Body `{ tierId }`, not a path param: the declarative page posts through a
`form`, and a form submits a body. Every mutating route in this plugin takes
its id the same way, for the same reason.

`accessInJail: false`. Synchronous, like combat and unlike crimes: there is no
shared outcome and no delay to model, so a BullMQ job would buy nothing but a
rule-1 idempotency key to maintain.

1. Look the tier up **before** claiming the cooldown, so a bad id costs
   nothing (the crimes-plugin ordering).
2. `ctx.cooldown.acquire("theft.steal", playerId, settings.cooldownSeconds)` —
   Redis `SET NX EX` inside the SDK, so rule 2 is satisfied structurally. On
   failure, 429 with `retry-after`. If anything after this throws, release it.
3. In the transaction, locks in order: location, then player.
4. Roll (see below). On success insert the garage row at the player's **current**
   location with the rolled damage. On failure run the chase.

Randomness is `randomInt` from `node:crypto`, never `Math.random`, and the
rolls are drawn in one place and handed to a **pure** resolver — the combat
`resolve.ts` shape, which is what makes the outcome table testable without a
database:

```ts
export interface TheftRolls { successRoll: number; carRoll: number; damageRoll: number; escapeRoll: number }

export function resolveTheft(
  rolls: TheftRolls, tier: TheftTier, candidates: readonly CatalogueCar[], escapeChance: number,
): TheftOutcome
```

- **success** when `successRoll < tier.successChance`
- **which car**: a weighted draw over the catalogue cars whose `value` falls in
  `[minCarValue, maxCarValue]`, weight = `theft_weight`. V2's `CA_theftChance`
  is a weight and not a percentage (SPEC §1.2), so it is a share of the bracket,
  not an independent roll. An empty bracket is not an error the player caused:
  it is `409 no_cars_in_tier`, and it does **not** consume the cooldown — the
  route checks the bracket before acquiring, alongside the tier lookup.
- **damage**: `randomInt(0, tier.maxDamage + 1)`, so a tier with `maxDamage: 0`
  yields pristine cars and does not throw (the `randomInt(n, n)` trap
  combat already hit).

### The chase

A failed theft is not an immediate jailing — that would leave `policeChase`, a
distinct V2 module, with no behaviour and the failure branch with no tension.

`escapeRoll < settings.chase.escapeChance` → the player gets away, and the
theft simply failed. Otherwise `tx.jail.sendToJail(playerId, settings.chase.jailSeconds)`.

No health loss, and no hospital branch. Hospital is combat's domain; a jailed
player is already out of action, and a second incapacitation state stacked on
the first is punishment without information.

## 5. Garage

### `GET /api/garage`

The caller's cars as a `TableRowsResponse`: car name, damage, the location's
name, the sale value, the repair cost, and whether the caller is standing in
that city. The garage row id is present as the select `valueKey` only. No
locks, no cooldown. Backs the garage table and both forms' `optionsSource`.

### `POST /api/garage/sell`

Body `{ garageId }`.

Requires the caller to be in the car's location — `409 wrong_location`
otherwise. Payout is the value scaled by damage:

```
payout = car.value * BigInt(100 - damage) / 100n
```

`bigint` division truncates, which is the correct direction: the house keeps
the fraction. The row is deleted and the payout moves through
`tx.economy.applyBalanceChange` (rule 3) with reason `theft.sell`.

### `POST /api/garage/repair`

Body `{ garageId }`. The garage's counterpart to spec 1's gunsmith,
deliberately the same shape.
Location-gated identically. Restores damage to 0 in one call; cost is
`settings.repair.costPerPoint * BigInt(damage)`. Insufficient cash is
`409 insufficient_funds`.

**Repairing an undamaged car is `204`, not an error** — the spec-1 gunsmith
ruling, kept for the same reason: a no-op is not a mistake, and charging for it
or 4xx-ing it both punish a double click.

## 6. Settings

Namespaced `theft.*` by the SDK; keys are declared bare, as in combat:

| key | default | note |
|---|---|---|
| `cooldown_seconds` | `300` | floored at 1 |
| `chase.escape_chance` | `40` | clamped 0–100 |
| `chase.jail_seconds` | `600` | flat, not per-tier — tiers carry no ordering column, and a derived ordering would be a second meaning for `success_chance` |
| `repair.cost_per_point` | `500` | `bigint` |

## 7. Events

**This cluster adds no `GameEvent` variant.** Theft publishes plugin events
through `tx.events.publish` with `describe` templates in the manifest, and
reaches for `publishCore` only for `player.jailed`, which already exists and
which the jail UI already listens to.

That is a departure from bounties and organized crime, which each widened the
core union, and it is deliberate. CLAUDE.md now records what widening costs:
three places break, and the third — the `CORPUS` drift guard — fails only
under the integration suite, which is how `player.backfired` shipped past two
task reviews. Nothing about a stolen car needs to be indistinguishable from a
core emission on the wire, so the union stays where it is.

Plugin events, with their invalidation keys declared in the manifest:

| name | audience | describe | invalidates |
|---|---|---|---|
| `theft.resolved` | player | `{actorName} stole a {carName}` / `{actorName} was spotted` | `theft`, `garage`, `me` |
| `garage.sold` | player | `{actorName} sold a {carName} for {payout}` | `garage`, `me` |

A failed chase that jails publishes `theft.resolved` **and then** `player.jailed`
— the crimes ordering: the module's own outcome first, the state change second.
Both are buffered and flushed after commit (rule 5).

## 8. Web

Two declarative pages via the manifest `pages` field and `PageSchema` — the
loader's page renderer, not hand-written React under `apps/web`. `theft` is the
first core plugin to declare `pages`, which is the point: keeping the UI in the
manifest is what would make it installable from the registry without touching
core.

A `view` is static, so all data arrives through `table.source` and
`select.optionsSource` GET routes. `/theft` is a table of tiers plus a
one-select form that steals; `/garage` is a table of the caller's cars plus a
sell form and a repair form, each selecting a car. Per-row action buttons are
not expressible in the ten-kind vocabulary — hence the select-then-submit
shape, which is the same one the admin pages already use.

`test/plugin-manifest-endpoint.test.ts` asserts the exact `GET /api/plugins`
payload of a no-arg boot, and today that is `{ menu: [], pages: [], events:
[inventory.purchased] }`. Both new pages and both new events appear there and
the assertion is updated with them. That test is the intended tripwire for
exactly this change, not collateral damage.

## 9. Admin

`adminPages` with two `table` views under `/api/admin/theft`, `auth: "admin"`:
the car catalogue (name, value, theft weight — create and edit) and the tier
table (name, success chance, max damage, value bounds — create and edit). No
UUID is rendered in either; ids travel only as each `select`'s `valueKey`,
which `test/admin-ids-hidden.test.ts` enforces across every loaded plugin.

## 10. Testing

Real Postgres and Redis; no mocks. Every file that drives the plugin without
`bootTestServer()` runs `runPluginMigrations(db, [theftPlugin])` itself — five
plugins already own tables and this makes six.

| file | proves |
|---|---|
| `theft-resolve.test.ts` | the pure resolver: bracket filtering, weighted draw, `maxDamage: 0`, the success and escape boundaries |
| `theft-routes.test.ts` | steal end to end — cooldown claimed and released, 409 on an empty bracket without spending it, garage row lands at the caller's location |
| `theft-chase.test.ts` | failure branches: escape publishes no jail; capture jails for `chase.jail_seconds` and publishes both events in order |
| `garage.test.ts` | sell payout truncation, repair cost, `204` on a pristine repair, `wrong_location` on both |
| `theft-lock-order.test.ts` | theft against real bullets and real travel, concurrently — and is shown failing when the lock order is inverted |
| `apps/migrate` | the retargeted writes, through the existing idempotency test |

The lock-order test earns its place only if it can fail. The plan requires
demonstrating it red against a deliberately inverted lock order before the
implementation is accepted.

## 11. Registration

`theft` is workspace-local, so it needs all eight registration sites, three of
which fail silently or only in CI (CLAUDE.md). `grep -c "packages/plugins/theft"
Dockerfile.server` must return 5, and
`npx tsc --build --force apps/server/tsconfig.json` must pass — the root
tsconfig hides a missing `apps/server/tsconfig.json` reference from
`npm run typecheck`.
