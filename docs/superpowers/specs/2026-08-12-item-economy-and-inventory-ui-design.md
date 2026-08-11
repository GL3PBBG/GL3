# Item economy (location shop) and the inventory/shop/combat/hospital UI — design

Date: 2026-08-12
Status: approved, awaiting implementation plan
Predecessor: `docs/superpowers/specs/2026-08-11-pvp-combat-design.md`

---

## 1. Why this, and why now

PvP combat shipped a complete item *use* story and no item *acquisition* story.
`docs/STATUS.md` records the consequence plainly: "there is no way to *obtain*
an item. No blackmarket, no trading, no shops — the only items in the game are
the two seeded starter rows and whatever an admin inserts directly."

The second half of the same gap is that none of it is reachable from a browser.
`packages/plugins/inventory` and `packages/plugins/combat` are the only two
gameplay plugins with no page in `apps/web`, and core hospital has none either.
A player can be killed, robbed of their on-hand cash and held in hospital
entirely through routes no page calls.

This design closes both: a **location shop** that sells items for cash, and the
four pages that make the item and combat loop playable — `/inventory`, `/shop`,
`/combat`, `/hospital`.

### Scope decision: shop now, blackmarket later

Player-to-player trading (V2's `blackmarket`) was considered together with this
and deliberately split into its own spec. It is a different system: listings,
item escrow, a cash transfer between two players, cancellation and expiry, and
a listing row that would have to be locked alongside two `player_stats` rows —
a fourth lock pair. It also cannot be the *first* acquisition route: on a fresh
database nobody owns anything to list, so a market without a shop is inert.

This spec ships **buy only**. There is no sell-back, deliberately: it halves the
route and test surface, and selling an equipped item would mean the shop
writing the equip slots that `inventory` owns. Turning items back into cash is
the blackmarket spec's job.

---

## 2. What already exists

- **`packages/plugins/inventory`** — `GET /api/inventory`,
  `PUT /api/inventory/equip`, `POST /api/inventory/use/:itemId`. Mirrors
  `items`, `player_items`, `player_stats` and `ranks` read-only-by-convention
  (`src/schema.ts`), and parses `items.effects` through `readEffects`. Declares
  **no tables and no migrations** today.
- **`packages/plugins/combat`** — `POST /api/combat/attack/:targetId`,
  `GET /api/combat/log`, all seven legality rules, `combat_log`, the
  player↔player lock pair.
- **Core hospital** — `GET /api/hospital`, `POST /api/hospital/discharge`,
  `settleHospital`.
- **`items`** (`apps/server/src/db/schema/content.ts`) — `id`, `name`,
  `item_type`, `effects` jsonb, `meta` jsonb. **No price column.**
- **`seedItems`** (`apps/server/src/db/seed.ts`) — "Rusty Pistol" (weapon) and
  "First Aid Kit" (consumable), ids generated with `uuidv7`, so nothing may
  hardcode one. `seedLocations` seeds three cities by name.
- **`apps/web`** — every gameplay page is hand-written React
  (`apps/web/src/pages/*.tsx`) with hooks in `api/queries.ts` and nav in
  `components/Shell.tsx`. Plugin *pages* (the `/api/plugins` view schema) are a
  static ten-kind vocabulary with no data binding, so they cannot render a list
  that comes from a request. `PAGE_OVERRIDES` is empty and core pages are not
  yet plugin pages ("Stage 3"). These four pages therefore follow the existing
  hand-written pattern.

---

## 3. Architecture

### 3.1 The shop lives inside `packages/plugins/inventory`

Not a new package. Three reasons, in order of weight:

1. **`effects.ts` would get a third copy.** A shop listing shows weapon damage
   and armor rating, so it needs the effect schemas. Those schemas are already
   duplicated by hand between `combat` and `inventory` — `docs/STATUS.md` lists
   the pair as a known gap kept in step by nothing. A separate `shop` package
   makes it three copies of a file that already drifts silently.
2. **Cohesion.** Own, equip, use and buy are all operations on "a player and
   their items", over exactly the tables `inventory` already mirrors.
3. **Registration cost.** A new plugin package has eight registration sites,
   three of which fail silently or only in CI (CLAUDE.md). Reusing `inventory`
   costs none of them.

The boundary is left clean enough to lift out later: shop code lives in its own
modules (`src/shop.ts`, `src/shop-schema.ts`), the table is prefixed
`p_inventory_shop_stock`, and nothing in the equip/use paths reads it.

The manifest changes to:

```ts
basePaths: ["/api/inventory", "/api/shop"],
tables: { shopStock: "p_inventory_shop_stock" },
migrations: [{ name: "0001_shop_stock", sql: ... }],
```

`inventory` gains its first table and its first migration. It still declares no
jobs — `buildApp` throws at boot if a core plugin declares any.

### 3.2 `GET /api/combat/targets` lives in `packages/plugins/combat`

The combat page needs a list of who can be shot, and there is no endpoint
anywhere that lists players in a location. It belongs to `combat` because it
evaluates combat's own legality rules and its own settings
(`newbie_exp_threshold`), neither of which `inventory` may read — `ctx.settings`
is namespaced per plugin precisely so one plugin cannot read another's config.

### 3.3 Web pages

Four hand-written pages in `apps/web/src/pages/`, four routes in `App.tsx`, four
nav entries in `Shell.tsx`. No plugin page schema is involved.

---

## 4. Data model

### 4.1 `p_inventory_shop_stock` (new, plugin-owned, `inventory` migration `0001`)

```sql
CREATE TABLE p_inventory_shop_stock (
  location_id uuid    NOT NULL,
  item_id     uuid    NOT NULL,
  price       bigint  NOT NULL,
  stock       integer NOT NULL,
  PRIMARY KEY (location_id, item_id)
);
```

**No foreign keys, deliberately, and this is the entry a future reader is most
likely to "fix".** A foreign key is a lock (CLAUDE.md rule 6): an FK to
`locations` or `items` would make every stock write take `FOR KEY SHARE` on
those rows. The buy handler already holds the `locations` row `FOR UPDATE` and
is about to take `player_stats`, so a `locations` FK is redundant lock traffic
on a row it already owns, and an `items` FK adds a lock edge to a table nothing
else locks. FK-free, this table adds **no lock edges at all** and cannot
participate in any cycle. The cost is real and accepted: a deleted item or
location leaves an orphan stock row. The listing query inner-joins `items`, so
an orphan is invisible to players; `ON DELETE CASCADE` is what is given up.

`price` is `bigint` because it is money. Note for whoever writes the Drizzle
mirror: a bigint column default must be written `` .default(sql`0`) ``, never
`.default(0n)`.

### 4.2 Seeding: `INSERT ... SELECT`, joined by name

The migration seeds stock in the same statement that creates the table, joining
core content **by name** because the ids are generated:

```sql
INSERT INTO p_inventory_shop_stock (location_id, item_id, price, stock)
SELECT l.id, i.id, v.price, v.stock
FROM (VALUES ('Rusty Pistol', 2500::bigint, 10), ('First Aid Kit', 500::bigint, 25))
       AS v(name, price, stock)
JOIN items i ON i.name = v.name
CROSS JOIN locations l;
```

In production, `index.ts` runs `seedItems` and `seedLocations` **before**
`loadPlugins`, so both sides exist and a fresh install has both starter items
for sale in all three cities. Where the seeds have not run the `SELECT` matches
nothing and the migration is a no-op that still records itself in
`plugin_migrations` — meaning **it will not retry later**. That is correct for
tests, which insert their own stock rows, and it is stated here so nobody
expects the migration to backfill a database seeded afterwards.

Prices are placeholders. Balance numbers are out of scope, exactly as they were
for combat; the intent is that a weapon costs meaningfully more than a heal.

### 4.3 No new `settings` keys

The shop has nothing to tune that is not a column: price and stock are per-row.

---

## 5. The shop

### 5.1 `GET /api/shop`

Stock at the caller's current location. `accessInJail` and `accessInHospital`
both default to `true` — browsing is not an action. Response:

```jsonc
{
  "locationId": "…",
  "items": [{
    "itemId": "…",
    "name": "Rusty Pistol",
    "itemType": "weapon",
    "effects": { … },   // through the existing readEffects
    "price": "2500",    // decimal string, never a JSON number
    "stock": 10
  }]
}
```

Inner join to `items`, so an orphaned stock row does not appear. `effects` goes
through `inventory`'s existing `readEffects`, so a listing shows the same
numbers combat will use — including the weapon defaults a migrated V2 item does
not carry. A player with no location gets `409 no_location`, the same answer
`POST /api/bullets/buy` gives.

### 5.2 `POST /api/shop/buy`

Body `{ itemId: uuid, quantity: int > 0 }`. `accessInJail: false`,
`accessInHospital: false` — buying is an action, and both gates are answered by
the loader with a `423` before the handler runs.

Handler order, which is the whole correctness argument:

```
1  read player_stats.location_id  (unlocked)
2  tx.locks.location(locationId)                       -- LOCATION FIRST
3  read the p_inventory_shop_stock row under that lock
4  cost = price * BigInt(quantity)
5  tx.economy.applyBalanceChange(-cost, "cash", "shop.purchase", refId: itemId)
6  UPDATE ... SET stock = stock - qty WHERE ... AND stock >= qty  RETURNING stock
7  INSERT player_items ... ON CONFLICT DO UPDATE SET qty = qty + n  RETURNING qty
8  tx.events.publish({ name: "purchased", audience: player })
```

- **Step 1 is unlocked and that is safe**, for the same reason the bullets port
  documents: a `travel` off this location must hold the row step 2 takes in
  order to commit, so it cannot slip in between. Reading it under the player
  lock instead would invert the location→player order.
- **Step 2 is the line this handler must keep first.** Step 5 is what acquires
  `player_stats` (`applyBalanceChange` locks internally), so no explicit player
  lock appears in the handler to hint at the ordering — it gets a comment
  saying so, as bullets' does.
- **Step 6's `stock >= qty` in the WHERE is the guard**, not the step-3 read.
  Under the location lock the read is already authoritative; the predicate is
  the same belt-and-braces shape as `use`'s `qty > 0`, and it is what makes the
  statement correct rather than merely currently-serialised. Zero rows returned
  means `insufficient_stock`.
- **Step 7's FKs are checked and safe.** `player_items` references `players`
  and `items`, so the insert takes `FOR KEY SHARE` on one row of each. Nothing
  in the codebase locks either table `FOR UPDATE` — the only `FOR UPDATE` sites
  are `player_stats`, `locations` and `gangs` — so this adds no lock edge and
  no new lock pair. This is the rule-6 check written down so the next reader
  does not have to redo it.
- **Step 8 is a plugin event**, not `publishCore`. None of the 19 core
  `GameEvent` variants covers a shop purchase, and adding one to `@gl3/shared`
  for one plugin's feature is a core schema change this does not need. Audience
  is the buyer alone: a purchase is private, matching `bullets.purchased`.

Response: `{ cash, itemId, qty, stock }`, `cash` and any money as decimal
strings.

### 5.3 Errors

| Condition | Status | Body |
|---|---|---|
| No session | 401 | `unauthorized` |
| Jailed / hospitalised | 423 | from the loader gate, with retry-after |
| Body fails zod | 400 | from the loader |
| Player has no location | 409 | `no_location` |
| Item not sold here | 409 | `not_sold_here` |
| Stock below quantity | 409 | `insufficient_stock`, `{ available }` |
| Cash below cost | 409 | `insufficient_funds` |

`InsufficientFundsError` from the ctx must be caught and rethrown as a
`PluginError` — the loader maps only `PluginError`, so without the catch an
overdraft is a 500. Same catch the bullets port carries.

---

## 6. `GET /api/combat/targets`

Read-only, no locks, no cooldown consumed. Returns up to **50** players in the
caller's location, ordered by exp descending. Bounded and **not paginated** —
the same deliberate limitation `GET /api/combat/log` already has, recorded here
rather than discovered later.

```jsonc
{ "targets": [{
    "playerId": "…", "username": "…", "rank": "Thug",
    "health": 84, "maxHealth": 100,
    "attackable": false, "reason": "gang_mate"
}]}
```

`reason` is one of combat's own legality answers — `hospitalised`, `jailed`,
`gang_mate`, `newbie_protected`, `newbie_self` (the caller is under the
threshold) — or absent when `attackable` is true. The caller's own row is
excluded rather than returned unattackable.

**Advisory only.** `attack` re-checks every rule under the lock; nothing here is
trusted. Its real value is that `attack` claims its Redis cooldown *before* the
transaction and deliberately never releases it on a 4xx, so firing at an
illegal target costs the attacker a full cooldown. A pre-evaluated list is what
stops the UI from spending a player's cooldown to discover a rule.

---

## 7. Web client

### 7.1 Hooks (`apps/web/src/api/queries.ts`)

`useInventory`, `useEquip`, `useUseItem`, `useShop`, `useBuyItem`,
`useCombatTargets`, `useAttack`, `useCombatLog`, `useHospital`, `useDischarge`.
Mutations invalidate `["me"]` whenever cash or bullets moved, plus their own
query key; a buy also invalidates `["inventory"]`, an attack also invalidates
`["combat","targets"]` and `["hospital"]`.

### 7.2 Pages

- **`/inventory`** — owned items grouped by type; weapon and armor slots showing
  what is equipped with equip and unequip (unequip sends an explicit `null`,
  which is why the request schema distinguishes absent from null); Use on
  consumables; health against max, so healing means something. `already_full`
  is explained in words rather than shown as a raw error.
- **`/shop`** — `Bullets.tsx`'s shape: price, stock, quantity input, total via
  `multiplyMoney`, buy disabled unless `canAfford`, plus the sold-out and
  "you aren't anywhere yet" states that page already handles.
- **`/combat`** — target list with illegal targets greyed and their `reason`
  shown, a fire button, and the recent log. Surfaces the attack cooldown via
  the existing cooldown handling.
- **`/hospital`** — mirrors `Jail.tsx`: remaining sentence, health, discharge
  cost from `GET /api/hospital`, and a pay-to-discharge button. Without this
  page a killed player meets a 423 on every action page with no way to read or
  clear it.

### 7.3 No web tests, by design

This repo has no DOM test environment; the web tests are pure functions over
`renderNode`'s output, and pages are verified by a human at a browser. These
four pages have exactly the standing of the twenty that already ship. The
server routes underneath them are integration-tested (§8).

---

## 8. Testing

Integration tests run against real Postgres and Redis. No mocks.

New and changed files:

- **`apps/server/test/shop.test.ts`** — listing at a location; the orphan row
  is invisible; buy happy path asserting `player_items.qty`, stock decrement,
  cash, and the ledger row; each 409 in §5.3; the jail and hospital 423s;
  money crosses the wire as a string.
- **`apps/server/test/shop-concurrency.test.ts`** — two buyers released
  together against the last unit in stock. Exactly one 200 and one 409
  `insufficient_stock`, one `player_items` row incremented, stock lands at 0
  and never negative. Must be demonstrated red first: with the step-6 predicate
  removed, stock goes negative.
- **`apps/server/test/combat.test.ts`** — extended for `targets`: each `reason`
  appears for the matching setup, the caller is absent from their own list, a
  player in another city is absent, and the route consumes no cooldown (a
  subsequent attack still succeeds).
- **`apps/server/test/economy-invariant.test.ts`** — a `shopBuy` op joins the
  1000-op sweep, driven through `callPluginRoute` exactly as `kill` is. This is
  the gate that matters: `sum(ledger) == balance` must hold across a money
  movement that also mutates two other tables.
- **`apps/server/test/plugin-migrate.test.ts`** — extended: `inventory`'s first
  migration applies once, is recorded in `plugin_migrations`, and re-running
  the loader does not duplicate stock rows.

Every acceptance test must be shown failing against deliberately broken code
before it is accepted. A green test that was never red proves nothing.

### Verification

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Read the exit code, not the summary. Also run
`npx tsc --build --force apps/server/tsconfig.json` — the command the image
build runs — since `inventory` gains modules that the root tsconfig would let
pass regardless. No new plugin package means no new `Dockerfile.server` COPY
lines are needed; `grep -c "packages/plugins/inventory" Dockerfile.server`
should still report 5.

---

## 9. Explicitly out of scope

| Item | Why |
|---|---|
| Blackmarket / player-to-player trading | Its own spec, next. Needs listings, escrow, a fourth lock pair. |
| Selling back to the shop | §1. Would mean the shop writing `inventory`'s equip slots. |
| Restocking (job or schedule) | Stock is seeded and admin-editable. The first plugin to declare a *second* job hits two documented latent bugs (`plugin_job_runs` PK omits the job name; a second `ctx.transaction` in a handler fails silently as success); no reason to meet them here. |
| Item drops from crimes or kills | Touches the crimes worker and combat resolution. Separate. |
| Admin UI for stock and prices | No admin surface exists yet anywhere in GL3. |
| `effects.ts` deduplication | The real fix is the equipment/inventory split deferred to this cluster's successor. This spec is careful not to make it worse (§3.1) but does not solve it. |
| Balance numbers | Placeholder prices. Tuning is its own pass, as it was for combat. |
| Kills leaderboard, `backfire` | Unchanged from the combat spec's deferrals. |
