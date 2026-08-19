# Properties as franchises — design

**Date:** 2026-08-16
**Status:** draft, awaiting review
**Supersedes in part:** `2026-08-15-properties-design.md` (income model, `cost`
semantics, one-row-per-location)

---

## 0. Why this exists

The `properties` cluster shipped on `feat/properties` with `plugin_id` as a
dormant flavour label and a flat per-hour `rate`. The V2 source was not
available at the time; SPEC §1.2's one-line note (`PR_module` varchar names
the module implementing the property) was the whole evidence base.

The V2 source has since been read
(`github.com/ChristopherDay/Gangster-Legends-V2`, `master`). It shows a
different mechanic, and shows SPEC §1.2 to be wrong in three places. This
design brings GL3's properties to V2's shape: **`plugin_id` becomes live**, a
property is a franchise of a specific plugin in a specific town, and income
comes from that plugin's own gameplay rather than from a clock.

### What V2 actually does

`install/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS `properties` (
  `PR_id` INT(11) NOT NULL PRIMARY KEY AUTO_INCREMENT ,
  `PR_location` INT(11) NOT NULL ,
  `PR_module` VARCHAR(128) NOT NULL ,
  `PR_user` int(11) NOT NULL DEFAULT 0,
  `PR_cost` int(11) NOT NULL DEFAULT 0,
  `PR_profit` INT(11) NOT NULL DEFAULT 0
) ENGINE = InnoDB;
```

- **No unique constraint anywhere.** The logical key is
  `(PR_location, PR_module)`, enforced only by convention: every query in
  `class/property.php` is `WHERE PR_location = :location AND PR_module = :module`,
  and `transfer()` INSERTs only when that SELECT found nothing. Two concurrent
  first-buys in one town produce two rows; V2 lives with it.
- The table ships **empty** (`install/data.sql` seeds no properties). Rows are
  created lazily, on first purchase.
- `PR_user`, **not** `PR_owner`. `NOT NULL DEFAULT 0`, where `0` = unowned and
  `-1` = "closed" (special-cased in `getOwnership`).
- `PR_module` is `VARCHAR(128)`, not 50.

`class/property.php` is a thin accessor — `getOwnership()`, `updateProfit()`,
`transfer()`, `setCost()` — all scoped to the acting user's current location.

`modules/installed/propertyManagement/` never sells anything. It is
manage-only and owner-gated: set cost, transfer to a named player, drop
(`DELETE`), reset the profit counter.

**Acquisition lives in the consumer module.** `bullets.inc.php:119` and
`blackjack.inc.php:124` each carry their own `method_own()` — identical,
hardcoded `$1,000,000`, deduct `US_money`, then `$property->transfer($user->id)`.
Two of 46 modules implement it; that is the entire set.

**`PR_cost` is the owner's lever, not a price.** Bullets reads it as the price
per bullet (`bullets.inc.php:86`); blackjack reads it as the max bet
(`blackjack.inc.php:276`). Minimum 100. `transfer()` zeroes it on handover.

**`PR_profit` is a resettable lifetime P&L stat, not a wallet.** Income is paid
to the owner immediately by the consumer; `updateProfit()` only moves the
counter. Bullets pays the owner **50% of every bullet sale** into `US_bank`
(`bullets.inc.php:225`). Blackjack credits the bet to the owner and debits the
payout (`:297`, `:406`) — the owner is the house and can lose.

**Kill seizure** (`propertyManagement.hooks.php`, `userKilled`): the shooter
takes every property the victim owned, game-wide, in one UPDATE.

### SPEC corrections this produces

`SPEC.md:75` and `SPEC.md:165` name the owner column `PR_owner`. It is
`PR_user`. Both lines are corrected by this cluster, and the column list gains
the `0`/`-1` sentinels and the real `VARCHAR(128)`.

### The M4 bug this exposes

`apps/migrate/src/migrators/properties.ts:13` selects `PR_owner`. Against a
real V2 database that is `ERROR 1054 Unknown column 'PR_owner' in 'field list'`
and the properties migrator dies. The fixture
(`apps/migrate/test/fixtures/v2-schema.sql`) hides it because the fixture was
reconstructed from the same wrong SPEC line
(`docs/superpowers/plans/2026-08-07-gl3-m4-migration-cli.md:45` states the
reconstruction outright). `-1` would additionally be looked up as a user id and
reported as an orphan.

This is a **live M4 defect independent of this cluster** and is fixed first, as
Phase 0 below, so that a real migration run is correct whether or not the rest
of this design ships.

---

## 1. Scope

**Phase 0 — M4 correctness** (independent, mergeable alone)
- fix the migrator to read `PR_user`, treat `0` as unowned and `-1` as closed
- correct the reconstructed fixture DDL to the real V2 DDL, including the
  absent unique constraint and `VARCHAR(128)`
- correct `SPEC.md:75` and `SPEC.md:165`

**Phase 1 — "C": property types become a declared, validated thing**
- new manifest field `providesProperties`, collected by the loader into a
  registry
- `unique(location_id)` → `unique(location_id, plugin_id)`
- admin edits `plugin_id` as a select over the registry, not free text
- `@gl3/plugin-sdk` additive patch bump + republish

**Phase 2 — "B": income comes from the consumer**
- `rate` and `last_claimed_at` dropped; the claim route and lazy accrual go
  with them
- `cost` reinterpreted as the owner's lever
- `@gl3/plugin-properties` exports `ownerAt` / `payOwner` for consumers
- `bullets` becomes the first consumer (V2's exact case)
- `profit` becomes a real P&L that can go negative; owner can reset it
- seizure-on-death via a `combat.killResolved` subscription

Out of scope, and deliberately so:

- **a casino/blackjack plugin.** Phase 2 makes the house model *buildable*
  (`payOwner` accepts a negative amount); it does not build it.
- **auctions, bids, rent, taxes, price drift.** Acquisition is the declared
  flat price, as in V2.
- **gang-owned properties.** `owner_player_id` stays a player.
- **`PR_user = -1` "closed" as a live GL3 state.** Phase 0 maps it to unowned
  on migration and it never reappears; GL3 has no admin path that sets it.

---

## 2. Phase 1 — declared property types

### 2.1 Manifest field

```ts
export interface PropertyTypeDecl {
  /** Stable key stored in properties.plugin_id. Must equal the plugin's own id. */
  id: string;
  /** Human label for the player page and the admin select. */
  name: string;
  /** Acquisition price in cents. V2 hardcoded $1,000,000 → 100_000_000n. */
  price: bigint;
  /** What `cost` means for this type, shown next to the owner's input. */
  leverLabel: string;
}
```

added to `PluginManifestInput` / `PluginManifest` as
`providesProperties?: PropertyTypeDecl[]` / `providesProperties: []`, validated
by a zod schema in `manifest.ts` alongside the existing ones (it is data, not
function-bearing, so it gets a real schema rather than `z.unknown()`).

`id` must equal the declaring plugin's own id. This is checked in
`definePlugin` so it fails on import with the plugin's id in the message. One
plugin may declare **at most one** property type; the field is an array only to
leave the door open, and the loader rejects a second entry today. *(Rationale:
V2's key is `(location, module)`, one row per module per town — a plugin
declaring two types would need a discriminator the key does not have.)*

### 2.2 Loader registry

`loadPlugins` collects every `providesProperties` entry into a
`Map<string, PropertyTypeDecl>` keyed by `id`, alongside the existing filter
point and admin page collection. Duplicate ids across plugins are a boot
failure, matching the existing route-collision behaviour.

The registry is exposed on every plugin's ctx as `ctx.propertyTypes`
(`get(id)` / `list()`). It is read-only loader state derived from manifests —
the same data `GET /api/plugins` already serves publicly — so there is nothing
to withhold, and a per-plugin ctx variant for one field would not earn its
complexity. It is the same shape as the existing `ctx.settings` accessor.

### 2.3 Unregistered rows stay alive

A row whose `plugin_id` resolves to nothing installed is **kept**, listed in
admin with an `unregistered` marker, and remains owned by whoever owns it. It
is not buyable (there is no declared price) and earns nothing (there is no
consumer to pay it). A live game migrating `'casino'` rows before a casino
plugin exists must not lose them.

### 2.4 Key change

```sql
DROP INDEX p_properties_location_key;
CREATE UNIQUE INDEX p_properties_location_plugin_key
  ON p_properties_properties (location_id, plugin_id);
```

as plugin migration `0003_location_plugin_unique`. This is the change that
makes the whole design work: a casino owner and a bullets owner coexist in one
town, exactly as V2's `(PR_location, PR_module)` allows.

Existing data survives it unchanged — the old constraint was strictly
stronger.

---

## 3. Phase 2 — consumer-paid income

### 3.1 Schema changes

Plugin migration `0004_franchise`:

```sql
ALTER TABLE p_properties_properties DROP COLUMN rate;
ALTER TABLE p_properties_properties DROP COLUMN last_claimed_at;
UPDATE p_properties_properties SET cost = 0;
```

- `rate` and `last_claimed_at` go: there is no clock any more.
- `cost` is reinterpreted from *purchase price* to *owner's lever*. Existing
  values are purchase prices and would be nonsense as levers, so they are
  zeroed; `0` means "the owner has set no lever — consumer, use your own
  default", which is exactly what
  V2's `transfer()` does when it zeroes `PR_cost` on handover.
- `profit` keeps its column and its data, and changes meaning from
  *lifetime paid out* to *lifetime P&L*. It can now go negative. Existing
  values are a correct starting P&L, so no backfill.

`schema.ts` and `settings.ts` follow. `income.cap` and `income.default_rate`
settings are removed; `admin.can_edit_rate` is removed. No settings replace
them — the price and the lever default are per-type manifest data, which is
where a plugin author can see them.

### 3.2 The consumer API

`@gl3/plugin-properties` exports two functions. Consumers depend on the package
and import them, exactly as `bounties` imports `killResolved` from
`@gl3/plugin-combat` (`packages/plugins/bounties/src/index.ts:2`) — the
established plugin→plugin dependency shape. The properties table is touched
only by code inside the properties package; encapsulation is by module, not by
process.

```ts
export interface PropertyOwnership {
  propertyId: string;
  ownerId: string;      // never null — see below
  /**
   * The owner's lever: `cost` when non-zero, else `null`, meaning "the owner
   * has not set one — use your own default". V2 does exactly this
   * (`bullets.inc.php:86`: `if (!!$owner["cost"]) $this->setCost(...)`), and
   * it is why the manifest declares no default. Bullets falls back to the
   * location's own `bullet_cost`, which is per-location and admin-editable;
   * a manifest constant could not express that.
   */
  lever: bigint | null;
}

/** Null when the property is unowned or does not exist. */
export function ownerAt(
  tx: PluginTx, pluginId: string, locationId: string,
): Promise<PropertyOwnership | null>;

/**
 * Credit (amount > 0) or debit (amount < 0) the owner, and move `profit` by
 * the same signed amount. Called inside the consumer's transaction.
 */
export function payOwner(
  tx: PluginTx, propertyId: string, amount: bigint, reason: string,
): Promise<void>;
```

Both take the **caller's** `PluginTx`, so the payment commits or rolls back
with the gameplay that produced it — a bullet sale that fails cannot leave the
owner paid.

**Lock order.** `payOwner` reaches `player_stats` for the owner. Every consumer
that calls it is already location-scoped and must therefore hold
`tx.locks.location(locationId)` before calling — which is the established
locations-first order (rule 6) and is what bullets already does. `payOwner`
takes `tx.locks.player([ownerId])` itself; a consumer that also acts on the
buying player must have taken **both** players through one
`tx.locks.player([buyer, owner])` call before calling `payOwner`, since
`lockPlayersForUpdate` sorts and that is what makes owner-buys-from-own-shop
safe. This is stated in the exported function's doc comment and proved by
`test/properties-consumer-lock-order.test.ts`.

**Debits clamp.** `payOwner` with a negative amount debits at most the owner's
current cash. A debit larger than the balance moves the balance to zero and
`profit` by the *actually moved* amount, so `profit` never claims a loss the
ledger did not take. All movement goes through `applyBalanceChange` (rule 3).

### 3.3 Acquisition and disposal

`plugin_id` being live changes who owns the buy route. It stays in the
`properties` plugin — GL3 does not repeat V2's copy-paste of `method_own()`
into every consumer.

| route | V2 equivalent | behaviour |
|---|---|---|
| `POST /api/properties/buy` | consumer `method_own()` | body `{ pluginId, locationId }`. Requires the caller be *in* that location. Price is `registry[pluginId].price`. Creates the row if absent (lazily, as V2 does). 409 `already_owned`, 409 `insufficient_funds`, 404 `unknown_property_type`. |
| `POST /api/properties/:id/lever` | `method_cost` | owner-only. Body `{ value }`, minimum `10_000n` cents — V2's `$100` floor, in GL3 units. |
| `POST /api/properties/:id/transfer` | `method_transfer` | owner-only, to a named living player. Zeroes `cost` on handover, as V2 does. Locks both players in one `tx.locks.player` call. |
| `POST /api/properties/:id/drop` | `method_drop`/`method_dropDo` | owner-only. Sets `owner_player_id = null`, `cost = 0`. **No refund.** |
| `POST /api/properties/:id/reset` | `method_reset` | owner-only. Sets `profit = 0`. Pure stat reset, moves no money. |

The `:id` routes take the property row `FOR UPDATE` after
`tx.locks.location` → `tx.locks.player`, unchanged from the shipped routes.

The old `claim` and `sell` routes are **removed**. `claim` has nothing to
claim. `sell` is replaced by `drop`, which is V2's behaviour: no exit value.
*(Consequence, called out for review: a property is a one-way money sink —
you pay `price`, you earn from gameplay, and you never get the principal back.
That is deliberate under the "don't break the economy" constraint, and it is
the single most reversible decision in this document.)*

### 3.4 Seizure on death

`properties` subscribes to `combat.killResolved` — the same shape as
`bounties`' `claimOnKill` (`packages/plugins/bounties/src/index.ts:163`),
which is the live precedent for this filter point.

V2 transfers the victim's properties **to the shooter**. GL3 does not: the
shooter already takes the kill's payout, and handing over a franchise on top
compounds a winner's lead. Instead every property the victim owned, **game-wide**,
becomes unowned — seized in the investigation — and returns to the market at
the declared price for anyone to buy.

```
owner_player_id = NULL, cost = 0   WHERE owner_player_id = victimId
```

`profit` is left alone; it is that row's lifetime P&L across owners.

Filters run **outside** the caller's transaction (`filters.ts`), so the
subscriber opens its own. A failed subscriber is logged and swallowed by
combat (`combat/src/index.ts:448`) — a seizure that fails does not undo a kill.

### 3.5 Events

Four plugin events, all `audience: "player"`, wire names un-namespaced
(the theft Task-5 ruling), `pluginId: "properties"` in the envelope:

| name | to | describe | invalidates |
|---|---|---|---|
| `bought` | buyer | `{actorName} bought the {typeName} in {location} for {price}` | `properties`, `me` |
| `dropped` | owner | `{actorName} dropped the {typeName} in {location}` | `properties`, `me` |
| `transferred` | recipient | `{actorName} transferred the {typeName} in {location} to you` | `properties`, `me` |
| `seized` | victim | `Your {typeName} in {location} was seized after your death` | `properties`, `me` |

**No `income` event.** V2 sends none, and one event per bullet sale would
flood the feed. Income is visible in the ledger and in `profit`.

No new core `GameEvent` variant, so `@gl3/shared` needs no bump for events —
but see §5, its DTOs change anyway.

### 3.6 First consumer: `bullets`

`bullets` gains:

```ts
providesProperties: [{
  id: "bullets",
  name: "Bullet Factory",
  price: 100_000_000n,          // $1,000,000 in cents — V2's hardcoded figure
  leverLabel: "Price per bullet",
}]
```

- in its buy route, after the existing location lock: `ownerAt(tx, "bullets",
  locationId)`; when owned with a non-null lever, that lever replaces
  `locations.bullet_cost` for this purchase (and `null` leaves the location
  price in force), then
  `payOwner(tx, propertyId, totalCost / 2n, "properties.bullets")` pays the
  owner half, as V2 does
- a dependency on `@gl3/plugin-properties`, plus the eight workspace
  registration sites for the dependency edge (CLAUDE.md conventions)

The owner buying from their own factory is the lock-order edge case §3.2
covers.

---

## 4. Player and admin surface

**`/properties`** (hand-written, `apps/web/src/pages/Properties.tsx`) changes
columns: location, type name, owner, and either a Buy button with the declared
price, or — when it is yours — the lever input, P&L, Reset, Transfer and Drop.
The `accrued` column goes.

> **Amended 2026-08-19 (`feat/properties-inline`):** the `/properties` tab is
> retired. The same hand-written React survives as
> `apps/web/src/components/PropertyPanel.tsx`, embedded on each declaring
> plugin's own page — the bullets page shows the factory, the casino lobby
> shows each game's table — with owner line, Buy when unowned, and the full
> owner tools when yours. Rule going forward: a plugin declaring a property
> type via `providesProperties` surfaces owner/buy on its own page. No API
> change; `GET /api/properties` still lists the caller's town and each panel
> filters by its `pluginId`.

**`/admin/properties`** keeps its manifest-declared `adminPages` table.
`plugin_id` becomes a select over the loader registry; `rate` leaves; a
`profit` column stays read-only *(admin does not adjust P&L — that is a ledger
lie waiting to happen)*; an `unregistered` marker appears for rows whose type
is not installed.

---

## 5. Package versions

- `@gl3/plugin-sdk` — `providesProperties` on the manifest, `ctx.propertyTypes`
  on the ctx. Additive → **patch, `0.1.1`**, published. First bump this package
  has taken.
- `@gl3/shared` — `PropertyRowSchema` / `PropertyListResponseSchema` change
  shape (`accrued`/`rate` out, `lever`/`price`/`typeName` in). This is a
  **breaking** change to an exported schema, but under `0.x` with no external
  consumer of these two symbols it ships as **patch, `0.1.5`**, and the change
  is noted in the publish. *(Flagged for review: the alternative is `0.2.0`,
  which invalidates every `^0.1.0` peer range in the wild and is a deliberate
  act, per CLAUDE.md. Recommendation is the patch.)*
- `@gl3/plugin-properties` — gains an export surface consumed by `bullets`;
  workspace-local, not published, no version discipline needed today.

---

## 6. Testing

Every test file is listed in `vitest.workspace.ts` (the ninth registration
site), and every file that drives a plugin without `bootTestServer()` runs
`runPluginMigrations` itself.

| file | project | proves |
|---|---|---|
| `properties-registry.test.ts` | `server:unit` | manifest validation; id-must-match-plugin; duplicate-id boot failure |
| `properties-routes.test.ts` (edit) | `server` | buy/lever/transfer/drop/reset, all error codes, unregistered rows inert |
| `properties-consumer-lock-order.test.ts` | `server` | owner-buys-from-own-shop does not deadlock; a consumer that skips the location lock is caught |
| `properties-pay-owner.test.ts` | `server` | credit, debit, debit-larger-than-balance clamps, `profit` matches ledger movement |
| `properties-seizure.test.ts` | `server` | kill disowns every victim property game-wide; failed subscriber does not undo the kill |
| `bullets-property.test.ts` | `server` | lever overrides location price; owner receives half; unowned factory behaves as today |
| `properties-events.test.ts` (edit) | `server` | four events, correct audience, `awaitOwnEvent` filtered by actorId (rule 4) |
| `admin-properties.test.ts` (edit) | `server` | select over registry, no UUID rendered, unregistered marker |
| `migrators/properties.test.ts` (edit) | `migrate` | `PR_user`, `0` → unowned, `-1` → unowned, real V2 DDL fixture |

`apps/server/test/schema.test.ts` is **not** affected: every change here is in
plugin migrations, and its census counts `public` FKs and indexes created by
*core* migrations. This is asserted rather than assumed — the plugin index
change in `0003` is verified against the guard by running the whole suite, not
a scoped run (CLAUDE.md: the last run before merge is the bare
`npm run verify`).

---

## 7. Risks

1. **`cost` changes meaning in place.** A live game's operators see the same
   column mean something new after `0004`. Mitigated by zeroing it (so no row
   carries a stale misinterpreted value) and by the admin label coming from
   `leverLabel`.
2. **Income stops for property types with no consumer.** After Phase 2 a
   migrated `'casino'` property earns nothing until a casino plugin ships.
   This is the intended V2 behaviour and the reason unregistered rows stay
   owned rather than being deleted, but it is a visible take-away on a live
   game and belongs in the release note.
3. **One-way sink.** §3.3. Reversible by adding a `sell` route that refunds a
   fraction of `price`; deliberately not done now.
4. **Plugin→plugin dependency edge.** `bullets` gains a hard dependency on
   `properties`. The precedent exists (`bounties` → `combat`) but the edge
   count is now two, and a third would be worth a look at whether the registry
   should mediate instead.
