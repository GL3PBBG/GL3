# Money ranks, backfire, and weapon condition — design

Status: approved, not yet implemented.
Branch: `feat/money-ranks-backfire`.

This is the first of four specs closing out the tables that `apps/migrate`
populates and no runtime code reads. The other three — car theft
(`cars`/`theft_tiers`/`garage`), properties, and rounds — get their own specs
in that order. Rounds goes last deliberately: a seasonal reset has to know
about every table that exists, so it is cheapest to write once the other three
have landed.

---

## 1. Why this, and why now

Three things ship together here because they touch the same two plugins and the
same public profile payload, not because they are one feature:

- **`money_ranks`** — a core table of wealth-bracket labels, migrated from V2's
  `moneyRanks`, rendered nowhere.
- **`player_stats.backfire`** — a core integer column, migrated from V2's
  `US_backfire`, read and written by nothing. The PvP combat design called it
  "a free design slot (attacker self-damage)" and deferred it.
- **Weapon condition** — new. Not a V2 table; added because backfire needs a
  reason to vary between players, and "your gun is worn out" is that reason.

There is no V2 behaviour to preserve for backfire. `US_backfire` was an integer
that the V2 kill module's logic consumed in ways this repo has no source for,
so the mechanic below is a fresh design, and its tests are the only
specification of it — the same footing PvP combat, bounties, detectives and
organized crime all shipped on.

---

## 2. What already exists

| Thing | Where | State |
|---|---|---|
| `money_ranks(id, label, threshold)` | `apps/server/src/db/schema/identity.ts:112` | core-owned, migrated, unread |
| `player_stats.backfire` | `identity.ts:64` | core-owned, `integer NOT NULL DEFAULT 0`, unread |
| Public profile route | `apps/server/src/game/profile/routes.ts` | core, deliberately excludes every money column |
| `ranks` plugin | `packages/plugins/ranks` | owns `/api/ranks` + `/api/admin/ranks`, mirrors core `ranks`/`player_stats`, owns no tables |
| `combat` plugin | `packages/plugins/combat` | owns `p_combat_log` and migrations `0001`–`0003`; `resolveShot` is pure with rolls injected |
| `WeaponEffectsSchema` | `packages/plugins/combat/src/effects.ts` **and** `packages/plugins/inventory/src/effects.ts` | duplicated by hand, nothing enforces the copies agree |
| `tx.economy.applyBalanceChange`, `tx.hospital.sendToHospital`, `tx.events.publishCore` | plugin SDK | all available to combat today |

`items` has **no** value or cost column — price lives in
`p_inventory_shop_stock`, which `inventory` owns. Any repair cost derived from
item value would require combat to read an inventory-owned table, which is the
first cross-plugin table dependency in the codebase. §5 avoids it.

---

## 3. Architecture

### 3.1 Ownership

- `money_ranks` stays **core-owned**. Core's profile route reads it; the
  `ranks` plugin edits it. That split already exists for `ranks` itself.
- Weapon condition is **combat-owned** (`p_combat_weapon_condition`, combat
  migration `0004`). Combat is the only plugin that reads or writes it: wear
  happens on a shot, repair happens at combat's gunsmith route. `inventory`
  never sees it.

Condition landing in combat rather than core follows the
`0007_relinquish_plugin_tables` rule — the single plugin that consumes a table
owns it. It would only have belonged in core if repair had lived in the shop,
which §5 rejects.

### 3.2 No new lock edges

`p_combat_weapon_condition` declares **no foreign keys**, matching
`p_inventory_shop_stock`. This is deliberate and load-bearing, for the reason
`combat/src/migrations.ts` already records about `p_combat_log`: rows in this
table are written while the transaction holds two `player_stats` rows
`FOR UPDATE`, so an FK to `items` or `players` would take `FOR KEY SHARE` at
that moment. A `players` FK would be player-then-player, which
`lockPlayersForUpdate` already orders safely; an `items` FK would introduce a
player→item edge that exists nowhere else. Declaring none keeps CLAUDE.md
rule 6's graph exactly as it is: gang↔player, location↔player, player↔player,
plus organized crime's heist-first order.

A row whose `player_id` or `item_id` no longer exists is harmless — it is read
by primary key from a path that has already loaded both, and is never joined
back.

### 3.3 No background job

Time decay is computed lazily on read from `updated_at`, never by a sweeper.
Nothing here enqueues BullMQ work, so CLAUDE.md rule 1 (at-least-once, needs an
idempotency key tied to `job.id`) does not apply to any code in this spec.

---

## 4. Money ranks

### 4.1 Bracket resolution

```sql
SELECT label FROM money_ranks
WHERE threshold <= :cashPlusBank
ORDER BY threshold DESC
LIMIT 1
```

- Wealth is `player_stats.cash + player_stats.bank`, summed as `bigint`.
- The comparison is **inclusive**: a player holding exactly `threshold` is in
  that bracket. Tested at the boundary.
- No matching row → `moneyRankLabel: null`. A game with an empty `money_ranks`
  table renders no label and does not error.

### 4.2 Public profile

`GET /api/players/:playerId/profile` gains two fields:

```
moneyRankLabel: string | null
backfire: number
```

This widens a payload whose comment currently says `player_stats` carries
cash/bank/points and "neither belongs on a public profile". That comment is
rewritten, not deleted, to state the actual rule: a **bracket** is public, a
**figure** is not. The route continues to select explicit columns and never
spreads a row.

`cash` and `bank` are selected only to compute the bracket and are never
returned.

### 4.3 Ranks plugin

- `GET /api/ranks` response gains `moneyRanks: [{ id, label, threshold }]`,
  ordered by threshold ascending. The existing `ranks` array is unchanged, so
  no client breaks.
- Admin CRUD under the plugin's existing `/api/admin/ranks` basePath, matching
  the shape the rank routes already use:
  - `GET /api/admin/ranks/money/list`
  - `POST /api/admin/ranks/money` (create) → 201 `{ id }`
  - `POST /api/admin/ranks/money/update` → 204, or 404 `money_rank_not_found`
- An `adminPages` section on the existing `/admin/ranks` page: a table plus
  create and update forms. The update form's `id` field is a `select` whose
  `valueKey` is `id` and `labelKey` is `label` — no UUID is rendered as a
  column, per `test/admin-ids-hidden.test.ts`.
- `threshold` crosses the wire as a decimal string (`MoneySchema` shape),
  validated by the same `/^\d+$/` pattern the rank routes use.

---

## 5. Weapon condition

### 5.1 Table

Combat migration `0004_weapon_condition`, one statement:

```sql
CREATE TABLE p_combat_weapon_condition (
  player_id  uuid        NOT NULL,
  item_id    uuid        NOT NULL,
  condition  integer     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, item_id)
)
```

Grain is `(player, item)`, matching core `player_items`. Stacking is a known
consequence: `player_items` has no per-instance identity, so a player who owns
two of the same pistol has one shared condition. Buying another copy does
**not** improve it — you cannot dilute wear. Nothing in the game distinguishes
individual copies today, so this introduces no inconsistency.

No index beyond the primary key: every read is by full key.

### 5.2 Decay

A missing row means **condition 100**. Every migrated player's weapons start
pristine, and no backfill migration is needed.

Pure function, no I/O, exhaustively testable — the shape `resolveShot`
established:

```ts
export function effectiveCondition(
  stored: number,
  updatedAt: Date,
  now: Date,
  decayPeriodSeconds: number,
  decayPerPeriod: number,
): number
```

```
elapsed  = max(0, (now − updatedAt) / 1000)
periods  = floor(elapsed / decayPeriodSeconds)
effective = clamp(0, 100, stored − periods × decayPerPeriod)
```

`decayPeriodSeconds` is floored at 1 by the settings reader, so the division
can never be by zero. A future `updatedAt` (clock skew) clamps `elapsed` to 0
rather than restoring condition.

### 5.3 Wear on use

After a shot resolves, inside the shot's own transaction:

```
next = clamp(0, 100, effectiveCondition(...) − wearPerShot)
INSERT ... ON CONFLICT (player_id, item_id)
  DO UPDATE SET condition = :next, updated_at = now()
```

Writing `updated_at = now()` resets the time-decay clock. That is deliberate:
time decay models rust from disuse, use decay models firing. A player who
shoots constantly accrues only use decay, and a player who never shoots accrues
only time decay. Both reach zero; neither double-counts.

Wear is applied on every shot, hit or miss — as with bullets, the cost is
firing, not connecting.

Unarmed attacks have no `weaponItemId`, write no row, and never wear anything.

### 5.4 Settings

Combat settings keys are **bare** here and namespaced to `combat.` by the SDK,
as `readCombatSettings` documents. Added to `CombatSettings`:

| Key | Default | Clamp |
|---|---|---|
| `condition.wear_per_shot` | 1 | `>= 0` |
| `condition.decay_period_seconds` | 86400 | `>= 1` |
| `condition.decay_per_period` | 1 | `>= 0` |
| `backfire.base_chance` | 2 | `0..100` |
| `backfire.wear_factor` | 3 | `>= 0` |
| `repair.cost_per_point` | `1000` (bigint) | `>= 0` |

All follow the existing `num`/`big` fallback discipline: a blank value falls
back to the default rather than coercing to zero, which is the trap
`readCombatSettings` already documents at length.

---

## 6. Backfire

### 6.1 Chance

```
base = weapon.backfireChance ?? settings.backfire.baseChance
mult = 1 + ((100 − condition) / 100) × settings.backfire.wearFactor
chance = min(100, round(base × mult))
```

A pristine weapon backfires at `base`. A ruined one at `base × (1 + factor)` —
with the defaults, 2% and 8%. A weapon whose `backfireChance` is explicitly `0`
never backfires at any condition, which is the same "explicit zero must
survive" property `accuracy: 0` already has in `WeaponEffectsSchema`.

Unarmed never backfires: no weapon, no condition row, no roll.

### 6.2 `WeaponEffectsSchema`

Gains `backfireChance: z.number().int().min(0).max(100).optional()`. Optional,
because a migrated V2 item arrives without one — the same reason `accuracy` is
optional.

⚠ `effects.ts` is **duplicated verbatim** between `packages/plugins/combat` and
`packages/plugins/inventory`, kept in step by hand with nothing enforcing it
(STATUS.md records this as a known hazard). Both copies get the field, and a
new test parses one fixture through both schemas and asserts identical output,
so the next drift fails a test instead of surfacing as combat reading an item
inventory wrote differently.

### 6.3 `resolveShot`

`Rolls` gains `backfireRoll: number` (from `randomInt(0, 100)` in `rollFor`,
`node:crypto` as ever — never `Math.random`). `WeaponProfile` gains
`backfireChance: number`. `ShotOutcome` gains:

```ts
backfire: boolean;
selfDamage: number;
```

**Backfire is evaluated before the hit roll.** A backfire is not a miss: the
gun went off in your hand. On backfire the function returns
`{ backfire: true, hit: false, crit: false, damage: 0, armorAbsorbed: 0,
selfDamage: <damageRoll>, bulletsSpent }`.

`selfDamage` is the raw damage roll, reduced by **no** armor — neither the
target's (irrelevant) nor the attacker's (armor does not protect you from your
own weapon). Bullets are spent, as on any shot.

The function stays pure and total: every existing test keeps passing, since a
`backfireChance` of 0 makes the new branch unreachable.

### 6.4 Effects in the attack route

On `outcome.backfire`, within the same transaction that already holds both
`player_stats` rows via `lockPlayersForUpdate`:

1. `player_stats.backfire` increments by 1 for the attacker. This requires
   adding `backfire` to combat's `playerStats` mirror in `schema.ts`.
2. Attacker health drops by `selfDamage`, floored at 0.
3. If attacker health reaches 0, `tx.hospital.sendToHospital(attackerId,
   config.hospitalSeconds)`. **No current code path hospitalises the
   attacker** — every existing call targets the victim — so this is new
   behaviour and gets its own integration test.
4. The target is untouched: no damage, no health write, no kill, no payout, no
   `killResolved` filter run. A backfire cannot claim a bounty.
5. A `p_combat_log` row is still written, with `hit = false`, `damage = 0`,
   `fatal = false`. The log answers "who shot at me", and someone did.

Bullets are deducted exactly as on a normal shot.

### 6.5 Event

No existing core `GameEvent` variant fits. `@gl3/shared` gains:

```ts
z.object({ ...base, type: z.literal("player.backfired"),
           selfDamage: z.number().int().nonnegative(),
           hospitalised: z.boolean() })
```

Published to the attacker only — the target has no way of knowing your gun
jammed, and telling them is information the attacker did not choose to give.

Per CLAUDE.md, this is an additive change to a **published** package:
`@gl3/shared` bumps to **0.1.2** and is republished to `npm.gl3.dev`. Existing
`^0.1.0` ranges resolve it; `@gl3/plugin-sdk` needs no bump of its own. This is
the exact shape the `player.discharged`/`0.1.1` change already took.

---

## 7. The gunsmith

`POST /api/combat/repair`, body `{ itemId: uuid }`, `auth` as the other combat
routes.

```
current = effectiveCondition(...)
restored = 100 − current
cost = settings.repair.costPerPoint × BigInt(restored)
```

- `restored === 0` → 204, no charge, no ledger row. Repairing a pristine weapon
  is a no-op, not an error.
- Insufficient cash → 409 `insufficient_funds`, matching the shop's existing
  string.
- Item not owned by the caller, or not `itemType === "weapon"` → 404
  `weapon_not_found`. Ownership is checked against `player_items`, so a weapon
  need not be equipped to be repaired. Combat's `schema.ts` currently mirrors
  no such table, so it gains a `playerItems` mirror (`player_id`, `item_id`,
  `qty`) alongside its existing core mirrors — read-only, no migration, exactly
  the pattern `inventory/src/schema.ts` documents.
- Cash moves through `tx.economy.applyBalanceChange` — one transaction, one
  ledger row, `bigint` throughout (rule 3). `test/economy-invariant.test.ts`
  covers the result.
- Condition is set to 100 with `updated_at = now()`.
- Response 200 `{ condition: 100, cost: "<decimal string>" }`.

No cooldown: cost is the limiter, and adding one would mean a Redis key, which
would mean rule 2's `SET NX EX` discipline for no gameplay gain.

Cost derives from a setting rather than item value because `items` has no value
column, and reading inventory's `p_inventory_shop_stock` would be the first
cross-plugin table read in the repo. A flat per-point rate is admin-tunable and
costs nothing structurally.

---

## 8. Web client

No new pages. Four existing ones change:

| Page | Change |
|---|---|
| `Combat.tsx` | Condition bar for the equipped weapon, backfire chance, repair button with its cost |
| `Profile.tsx`, `PlayerProfile.tsx` | Money-rank label beside rank name; backfire count as a stat |
| `Ranks.tsx` | Money-rank ladder alongside the exp ladder |
| `lib/eventCopy.ts` | Copy for `player.backfired` |

`Admin.tsx` needs no change — the money-ranks admin section arrives through the
`ranks` plugin's `adminPages` manifest and the existing renderer.

---

## 9. Testing

Integration tests run against real Postgres and Redis; no mocks on DB, queue or
bus paths.

**Pure units** (no DB):
- `effectiveCondition` — zero elapsed, exact period boundaries, partial
  periods, clamping at 0 and 100, future `updatedAt`, `decayPerPeriod = 0`.
- `resolveShot` backfire branch with fixed rolls — backfire wins over a hit
  roll that would otherwise connect; `backfireChance: 0` is unreachable;
  `selfDamage` ignores both armor values.
- Backfire chance arithmetic at condition 100, 50 and 0.
- `effects.ts` parity: one fixture through both copies of
  `WeaponEffectsSchema`, output compared.

**Integration:**
- A forced backfire increments `player_stats.backfire`, reduces attacker
  health, leaves the target's health untouched, and writes a
  `hit = false, damage = 0` log row.
- A backfire that reaches 0 health hospitalises the **attacker**.
- Wear reduces condition on a shot; a row is created on first shot.
- Decay applies with `updated_at` planted in the past.
- Repair charges the right amount, restores to 100, and preserves
  `sum(ledger) == balance`.
- Repair with insufficient cash returns 409 and moves no money.
- Money-rank bracket at exactly `threshold`, below the lowest threshold
  (null), and with an empty table.
- Public profile returns the label and backfire count and still returns no cash
  or bank field.
- Money-ranks admin create/update round trip, and 404 on an unknown id.

**Discipline:**
- Any event assertion filters on its own `actorId` via `awaitOwnEvent()`
  (rule 4).
- Any new test file that drives `combat` without `bootTestServer()` calls
  `runPluginMigrations(db, [combatPlugin])` itself, or dies on 42P01.
- Each acceptance test is shown failing before the code that satisfies it
  lands.

### Verification

`npm run verify` run bare — not piped through `grep` or `tail`, which discard
npm's exit status — with `DATABASE_URL` and `REDIS_URL` exported. A non-zero
exit is a failure even when every test is reported passing.

`npx tsc --build --force apps/server/tsconfig.json` as well, since no new
plugin package is added but `@gl3/shared` changes and CI's typecheck differs
from the local one.

---

## 10. Explicitly out of scope

| Deferred | Why |
|---|---|
| Armor condition | Only weapons degrade. Armor has no firing event to hang wear on, and time-only decay is a different mechanic. |
| Per-instance item identity | `player_items` is qty-stacked. Splitting it is a much larger change that the item economy would drive, not this. |
| Wealth leaderboard | Leaderboard is a core non-port with no wealth board. Adding one widens this spec for no dependency. |
| Repair kits, shop repair | Repair lives at combat's gunsmith. A consumable would need a new item type and seeded stock. |
| Backfire from crimes or organized crime | Backfire is a combat mechanic here. Other modules can adopt it later without schema change. |
| Condition affecting accuracy or damage | Condition feeds backfire chance only. One stat, one effect, one thing to balance. |
