# PvP combat — design

**Date:** 2026-08-11
**Scope:** the `combat` plugin, a minimal `inventory` plugin, and core hospital.
**Status:** design approved, not yet planned.

---

## 1. Why this, and why now

Nine module ports have shipped (`ranks`, `notifications`, `news`, `bank`,
`bullets`, `travel`, `crimes`, `mail`, `gangs`) — M5's module-port track is
complete. Everything ported so far is either single-player (crimes, travel,
bullets, bank) or communication (mail, news, notifications, gangs). **No player
can affect another player's state.** Gangs share a bank; nobody can take
anything from anyone.

GL2's remaining unported gameplay splits into clusters:

| Cluster | GL2 modules | GL3 schema present? |
|---|---|---|
| **PvP combat** | kill, hospital, weapon/armor equip | yes — `weapons`, `items`, `player_items`, `health`, `hospital_until`, `player.attacked`/`player.killed` |
| Contracts | bounties | yes — `bounties` + both events |
| Hunting | detectives, search, usersOnline | yes — `detective_searches` |
| Item economy | inventory, blackmarket | yes — `items`, `player_items` |
| Car economy | cars, garage, theft, policeChase | yes — `cars`, `garage`, `theft_tiers` |
| Passive income | properties | yes — `properties.plugin_id` |
| Talk | forum, chat | no tables (`chat.message` event exists) |
| Non-multiplayer | casino, membership | no tables; SPEC §6 says stub |

PvP combat is the root of the multiplayer half. Bounties are contracts on
kills; detectives find targets to kill; blackmarket sells weapons. None of
those mean anything until players can hurt each other.

Each cluster gets its own spec → plan → implementation cycle. This is the
first.

### Fidelity stance

**GL3-native design, GL2 schema as the constraint.** GL2's `kill` module
source is not consulted; mechanics are designed fresh against the columns that
already exist. A migrated V2 player keeps their data and finds combat behaves
differently.

This is a deliberate departure from the nine ports, every one of which
preserved core's wire contract byte for byte. There is no GL3 predecessor to
preserve here — this is new gameplay on migrated data, not a port.

---

## 2. What already exists, and one thing that does not

Verified against the schema, not assumed:

- `player_stats.health` (int, default 100), `backfire` (int, unused by
  anything in GL3), `hospital_until` (timestamptz), `weapon_item_id`,
  `armor_item_id`.
- `ranks.max_health` — the health cap is rank-derived.
- `items(id, name, item_type, effects jsonb, meta jsonb)`, `player_items(player_id,
  item_id, qty)`.
- `player.attacked` and `player.killed` are already variants of
  `GameEventSchema` (`packages/shared/src/events.ts:36,38`).
- `lockPlayersForUpdate` already exists (`apps/server/src/economy/ledger.ts:35`)
  — ascending-UUID, deduped, no-op on empty. **No route calls it today.** The
  player↔player lock order is therefore already established in core; this work
  exposes it on the plugin ctx rather than inventing one.

**There is no `shot_by` column.** V2 had `US_shotBy`; SPEC §2.5 dropped it.
Death attribution needs somewhere to live — see §4.

### The weapons/items split

`player_stats.weapon_item_id` and `armor_item_id` both reference **`items.id`**,
not `weapons.id`. Nothing anywhere references `weapons`.

The M4 fixture confirms this is what V2 actually does:
`userStats.US_weapon = 1`, `US_armor = 2` point at `items` rows (item 1
`Baseball Bat` type `weapon` with `itemEffects(damage, 15)`; item 2
`Kevlar Vest` type `armor` with `itemEffects(armor, 20)`), while the V2
`weapons` table (Pistol 60, Shotgun 45) is referenced by nothing. It is a
parallel, orphan catalog.

**Decision: equipment is items-only.** `weapons` stays a migration-target
catalog and is not deleted — M4 Task 17 is already written as a verbatim
`weapons` → `weapons` copy, and deleting the table would break the migrator
before it exists.

Consequence: V2 item effects carry `damage` and `armor` but **no accuracy**.
Migrated weapons need an accuracy default (§4, `combat.default_weapon_accuracy`).

---

## 3. Architecture

Three deliverables.

### 3.1 `packages/plugins/combat` (plugin id `combat`)

| Route | `accessInJail` | `accessInHospital` |
|---|---|---|
| `POST /api/combat/attack/:targetId` | `false` | `false` |
| `GET /api/combat/log` | `true` | `true` |

Owns `combat_log`, hit/damage/armor resolution, and the death cash transfer.
Reads equipped items; writes `player_stats.health`; calls
`tx.hospital.sendToHospital`.

### 3.2 `packages/plugins/inventory` (plugin id `inventory`)

Minimal: own, equip, use. **No shop, no trading, no blackmarket** — those stay
with the item-economy cluster.

| Route | `accessInJail` | `accessInHospital` |
|---|---|---|
| `GET /api/inventory` | `true` | `true` |
| `PUT /api/inventory/equip` | `false` | `false` |
| `POST /api/inventory/use/:itemId` | `false` | `false` |

Owns `player_items`; writes `weapon_item_id` / `armor_item_id`; applies
`items.effects` (`heal` is the only effect this spec implements).

Consuming an item is an inventory action, not a combat one; equipping an item
is an inventory action too. Combat only *reads* what is equipped. GL2 agreed —
`kill`, `hospital` and `inventory` were three separate modules.

### 3.3 Core hospital (`apps/server/src/game/hospital/`)

**Jail and hospital are core state facilities.** The principle: a facility is a
state that *gates every plugin's routes*, so its gate must live where the route
loader is. A third-party plugin can hold a player through its own ctx
capability, but it cannot gate other plugins' routes — and should not be able
to.

This follows the jail precedent exactly (`apps/server/src/game/jail/`, a
deliberate non-port): the gate lives in core, the capability reaches plugins as
`tx.jail.sendToJail`.

- `GET /api/hospital` — status.
- `POST /api/hospital/discharge` — pay cash, clear the sentence early.
- `accessInHospital?: boolean` on the plugin route definition, alongside
  `accessInJail`. Default `true`, so the nine existing plugins are unaffected.
  423 + `retry-after` when gated.
- `tx.hospital.sendToHospital` on the ctx, mirroring `tx.jail.sendToJail`.

The loader gate has two consumers on day one (both new plugins) and is the same
mechanism jail already uses. Building it plugin-local would mean every future
plugin re-implements the check by hand, and one of them forgets.

### 3.4 Other core additions

1. **`tx.locks.players`** on the plugin ctx — a passthrough to the existing
   `lockPlayersForUpdate`. No new lock order is invented.
2. **`combat_log`** table + core migration `0005`. Core owns and migrates it
   (same arrangement as `crime_log`); the combat plugin mirrors it in its own
   `schema.ts`.
3. **Two seeded `items` rows** in `apps/server/src/db/seed.ts` — a starter
   weapon and a heal consumable — so equip is not inert before a shop exists.

### 3.5 Deferred boundary

When the item-economy cluster lands (blackmarket, trading, shops), revisit
whether equip/use belong in a broader `inventory` package or split again.
Not now: three routes, no independent value, and `blackmarket` will redraw that
seam anyway.

### 3.6 Registration cost

Two new plugin packages × the eight registration sites in CLAUDE.md, three of
which fail silently or only in CI:

`packages/plugins/<id>/` · `apps/server/package.json` (+ `npm install`) ·
`apps/server/tsconfig.json` references · root `tsconfig.json` references ·
`vitest.workspace.ts` `srcAliases` · `plugins/core-plugins.ts` · any old
registration to delete · **five COPY lines in `Dockerfile.server`**.

Checks: `grep -c "packages/plugins/combat" Dockerfile.server` = 5, same for
`inventory`; `npx tsc --build --force apps/server/tsconfig.json` for the
CI-only tsconfig failure.

---

## 4. Data model

### 4.1 `combat_log` (new, core-owned, migration `0005`)

Named for shots, not kills — every shot logs a row and `fatal` marks the last
one. Bounties and detectives will read this later, and "who shot me" needs
misses too: being shot at and surviving is information. This table is also
where death attribution lives, replacing V2's dropped `US_shotBy`.

```
combat_log   id             uuid pk
             attacker_id    uuid not null → players (cascade)
             target_id      uuid not null → players (cascade)
             hit            boolean not null
             damage         int not null default 0
             fatal          boolean not null default false
             weapon_item_id uuid null → items (set null)
             payout         bigint not null default 0   -- cash taken, fatal only
             created_at     timestamptz not null default now()
  indexes:   (target_id, created_at), (attacker_id, created_at)
```

**There is deliberately no `location_id` column**, and the reason is
load-bearing. `combat_log`'s FKs are taken while the transaction holds two
`player_stats` locks. A `locations` FK would take `FOR KEY SHARE` on a location
row at that point — **player-then-location, the inverse of the established
location↔player order** — closing an ABBA cycle against `travel` and `bullets`.
That is CLAUDE.md rule 6 exactly: the lock is invisible in the code because no
lock call appears. The location is recoverable from context and is not worth an
inverted lock order.

The remaining FKs are safe: nothing locks `items`, and the two `players` FKs
point at rows already held `FOR UPDATE`, which subsumes `FOR KEY SHARE`.

**No `job_id`.** This is a synchronous route (§5.1), so there is no BullMQ job
and no `plugin_job_runs` key. The Redis cooldown is the replay guard.

### 4.2 `items.effects` shapes

Zod-parsed on every read — never trusted raw — keyed by `items.item_type`:

| `item_type` | `effects` |
|---|---|
| `weapon` | `{ accuracy: 0-100, damageMin, damageMax, bulletsPerShot ≥ 1, critChance: 0-100, critMultiplier ≥ 1, armorPierce ≥ 0, minRankExp ≥ 0 }` |
| `armor` | `{ armor ≥ 0 }` |
| `consumable` | `{ heal > 0 }` |

Every weapon field except `accuracy` / `damageMin` / `damageMax` **defaults on
parse** — `bulletsPerShot: 1`, `critChance: 0`, `critMultiplier: 1`,
`armorPierce: 0`, `minRankExp: 0` — so a migrated V2 item carrying only
`damage` parses without backfill.

**M4 mapping:** V2 `itemEffects` yields `damage` and `armor` only. A migrated
weapon maps `damage → damageMin = damageMax`, and accuracy falls back to
`combat.default_weapon_accuracy`. The orphan V2 `weapons` catalog stays a
straight table copy per M4 Task 17 and feeds nothing.

**`minRankExp`, not a rank id.** Ranks are UUID rows ordered by `exp_required`,
so "rank ≥ X" is really an exp comparison. Storing the exp threshold compares
against `player_stats.exp` directly — no join, and no dangling pointer when a
rank row is edited or deleted (V2 ranks are admin-editable data). It is
enforced today at equip time, so it is not dead config waiting on a shop; a
shop would only be a second, earlier gate.

**`critMultiplier` is a float in jsonb** and multiplies damage. Damage stays
integer: `floor(damage × multiplier)`. No float ever reaches a `bigint` or the
ledger.

**`bulletsPerShot` is per weapon**, not a global setting — it is the stat that
creates a genuine trade-off (damage against ammo cost) with an existing
resource. `combat.unarmed.*` keeps a bullets cost for the unarmed case.

### 4.3 `settings` keys

Text values, zod-parsed with defaults so a fresh database works unseeded:

```
combat.cooldown_seconds               shot cooldown
combat.unarmed.accuracy               no weapon equipped
combat.unarmed.damage_min
combat.unarmed.damage_max
combat.unarmed.bullets_per_shot
combat.default_weapon_accuracy        fallback for migrated weapons
combat.newbie_exp_threshold           mutual protection floor
combat.hospital_seconds               sentence on death
hospital.discharge_cost_per_second    cash to clear early
```

Balance numbers are explicitly out of scope. The intent recorded for whoever
tunes them: **cash discharge should be expensive relative to heal items.**

### 4.4 No new `player_stats` columns

`health`, `hospital_until`, `weapon_item_id`, `armor_item_id` and `backfire`
all already exist. `backfire` stays unused — a free design slot (attacker
self-damage on a botched shot, in V2 terms), deliberately deferred, with no
existing behaviour to preserve.

---

## 5. Attack resolution and data flow

### 5.1 Synchronous route, not a BullMQ job

SPEC §7 says random outcomes resolve "in workers only so retries can't re-roll
a favorable outcome (job payload carries a seed generated at enqueue time)."
Combat deviates from the letter and keeps the intent.

The Redis cooldown is claimed **before** the transaction, so a retry inside the
cooldown window is rejected outright rather than re-rolled. There is no re-roll
to protect against. In exchange, the shooter sees the result in the response
rather than waiting for a socket frame — combat wants immediate feedback more
than any other action in the game.

Secondary benefit: this path avoids the two latent job bugs recorded in
`docs/STATUS.md` (a handler may open only one `ctx.transaction`; the
`plugin_job_runs` PK omits the job name).

### 5.2 Request path

`POST /api/combat/attack/:targetId`, zod-validated UUID param.

1. **Cooldown first** — `ctx.cooldown` claim over `combat.cooldown_seconds`
   (Redis `SET NX EX`, CLAUDE.md rule 2). Failure → 429 + `retry-after`.
2. **Jail / hospital gates** — loader level, both `false`. 423 + `retry-after`.
3. **One `ctx.transaction`:**
   - `tx.locks.players([attackerId, targetId])` — ascending UUID, the existing
     helper. **First statement in the transaction**, before any read that
     matters.
   - `settleHospital` for both players (§6.3).
   - Read both stat rows, the attacker's equipped weapon, the target's armor,
     both rank rows for `max_health`, both `gang_members` rows.
   - **Legality**, in this order, each its own `PluginError`.
   - Debit bullets (`bulletsPerShot`).
   - **Resolve** (§5.3).
   - Apply damage; on death, transfer and hospitalise (§5.4).
   - Insert the `combat_log` row.
4. **Publish after commit** — `tx.events.publishCore`, buffered in the
   transaction and flushed by the loader (CLAUDE.md rule 5).

### 5.3 Legality

All seven checks apply. In order:

| Check | Error |
|---|---|
| target is self | `400 self_attack` |
| target in hospital | `409 target_hospitalised` |
| target in jail | `409 target_jailed` |
| different `location_id` | `409 target_elsewhere` |
| same gang | `409 same_gang` |
| either side below `newbie_exp_threshold` | `409 protected` |
| attacker bullets < `bulletsPerShot` | `409 insufficient_bullets` |

The attacker's own jail/hospital state is handled by the loader gate, not here.

**Same-gang is a flat rule, not a per-gang policy.** A `gangs.friendly_fire`
column was considered and rejected: `GANG_PERMISSIONS` already exists in three
places with a documented drift risk, and this would add a fourth policy surface
for one boolean.

**Newbie protection is mutual** — below the threshold you can neither be
attacked *nor* attack. One-way protection would let a newbie farm with
impunity.

### 5.4 Resolution

Two-stage: roll to hit, then roll damage. All rolls use `node:crypto`
`randomInt`, never `Math.random` (SPEC §7).

```
hit    = roll(100) < weapon.accuracy         -- unarmed → settings accuracy
  miss → damage 0, log, event, done
damage = randomInt(damageMin, damageMax + 1)
crit   = roll(100) < weapon.critChance
  if crit → damage = floor(damage × critMultiplier)
armor  = max(0, targetArmor - weapon.armorPierce)
damage = max(0, damage - armor)
health = max(0, targetHealth - damage)
```

**Crit multiplies before armor subtracts.** Armor blunts a crit rather than a
crit bypassing armor: pierce is the stat that beats armor, crit is the stat
that beats health. Two counters, two distinct roles.

A hit reduced to zero by armor still logs `hit: true, damage: 0` — "your armor
held" is different information from "he missed."

### 5.5 On death (`health` reaches 0)

- The killer takes the victim's **entire on-hand `cash`**; bank is untouched.
  Two `tx.economy.applyBalanceChange` calls — one debit, one credit — inside
  the locked transaction. Both ledgered, so `sum(ledger) == balance` holds on
  both sides. Bank deposits become real counterplay, which the shipped `bank`
  plugin already supports.
- Victim: `health = 0`, `hospital_until = now + combat.hospital_seconds` via
  `tx.hospital.sendToHospital`.
- `combat_log` row with `fatal: true` and `payout` set.
- Two events, in order: `player.attacked`, then `player.killed`.

### 5.6 Events

`player.attacked` — actor is the attacker, `{ targetId, targetName, damage }`.
`player.killed` — actor is the killer, `{ victimId, victimName }`. Both are
existing `GameEventSchema` variants published verbatim through
`tx.events.publishCore`; no `plugin.event` envelope.

**Audience: attacker and victim only, never global.** A global audience would
broadcast every shot in the game to every connected socket and leak position —
anyone watching the firehose learns who is where. Public kill announcements are
a `news.posted` decision for a later spec, not a fan-out default.

A miss still publishes `player.attacked` with `damage: 0`; the victim needs to
know someone is shooting at them.

### 5.7 Response

200 with `{ hit, crit, damage, armorAbsorbed, targetHealth, targetKilled,
payout, bulletsSpent }`. The victim learns of it over the WebSocket.

### 5.8 Two deliberate costs

- **The cooldown is claimed before the legality checks**, so attacking an
  illegal target still burns it. Releasing it on a 4xx would be a
  check-then-act on Redis (CLAUDE.md rule 2). Better to burn a cooldown than to
  hand out a free-probe primitive that lets a client scan who is in hospital at
  no cost.
- **Bullets are debited on a miss.** Ammo is the cost of shooting, not of
  hitting.

---

## 6. Inventory and hospital behaviour

### 6.1 `packages/plugins/inventory`

**`GET /api/inventory`** — owned items (`player_items` ⋈ `items`, `qty > 0`)
with parsed effects, plus the two equipped ids.

**`PUT /api/inventory/equip`** — body `{ weaponItemId?: uuid | null,
armorItemId?: uuid | null }`. An explicit `null` unequips that slot; an absent
key leaves it alone. Rejects: not owned (`409 not_owned`), wrong `item_type`
for the slot (`400 wrong_slot`), `minRankExp > player.exp`
(`409 rank_too_low`). Writes under `tx.locks.players([self])`.

**`POST /api/inventory/use/:itemId`** — consumables only. Decrements qty with
`UPDATE … qty = qty - 1 WHERE qty > 0 RETURNING` (no check-then-act), then
applies `effects.heal`, capped at the player's `ranks.max_health`. Rejects: not
owned, not a consumable (`400 wrong_slot`), already at full health
(`409 already_full`).

### 6.2 Core hospital

**`GET /api/hospital`** — `{ health, maxHealth, hospitalUntil, dischargeCost }`.

**`POST /api/hospital/discharge`** — cost is
`remaining_seconds × hospital.discharge_cost_per_second`, debited via
`applyBalanceChange`; clears `hospital_until` and restores health to
`max_health`. `409 not_hospitalised` when not in hospital.

`discharge` is `accessInJail: true` deliberately — jail and hospital are
independent sentences, and being jailed should not block paying off the ward.

**Heal items do not clear hospital.** Items heal you while alive; hospital is a
state you leave by waiting or paying, which keeps the facility meaningful. This
is enforced structurally rather than by a handler check:
`POST /api/inventory/use/:itemId` carries `accessInHospital: false`.

### 6.3 `settleHospital` — expiry must not be lazy-on-read

Core exports `settleHospital(tx, playerId)`: if `hospital_until <= now`, set
`health = max_health` and null the column.

Without it the state is exploitable. A player whose sentence has elapsed still
has `health = 0` in the row until something touches them, so they could be
attacked at 0 health and instantly re-killed.

Combat calls it for **both** attacker and target immediately after
`tx.locks.players`, before any legality check — inside the lock, so it cannot
race the attack that reads its result. The route gate and `GET /api/hospital`
call it too.

---

## 7. Errors

Every failure is a `PluginError(code, status)`; the loader maps it to a
response. No plugin overdraft may surface as a 500 —
`tx.economy.applyBalanceChange` throws the SDK's `InsufficientFundsError`,
translated in `apps/server/src/plugins/ctx.ts`. Combat catches it on the
discharge path only; the death transfer cannot overdraw, since it moves exactly
the balance it read under lock moments earlier.

| Status | Codes |
|---|---|
| 400 | `self_attack`, `wrong_slot` |
| 404 | `no_such_target`, `no_such_item` |
| 409 | `target_hospitalised`, `target_jailed`, `target_elsewhere`, `same_gang`, `protected`, `insufficient_bullets`, `not_owned`, `rank_too_low`, `already_full`, `not_hospitalised` |
| 423 | jailed / hospitalised (loader, with `retry-after`) |
| 429 | cooldown (with `retry-after`) |

---

## 8. Concurrency and lock order

### 8.1 Failure modes this design must survive

1. **Simultaneous killers.** Two attackers, one victim at 1 hp.
   `tx.locks.players` serialises them; the loser reads `health = 0` and a set
   `hospital_until`, and is rejected `target_hospitalised`. Exactly one payout.
   Without the lock both would credit from the same cash read — a duplication
   bug, not merely a double kill.
2. **Mutual attack in opposite order.** A shoots B while B shoots A. Both lock
   ascending by UUID, so no ABBA cycle forms. This is the deadlock case the
   implementation must prove.
3. **Elapsed sentence.** Closed by `settleHospital` inside the lock (§6.3).
4. **Equip racing a shot.** The weapon is read inside the same locked
   transaction, so the shot uses whichever committed first. Deterministic
   either way.
5. **Cash arriving between read and transfer.** Impossible — the victim's row
   is locked before the read.

### 8.2 Three lock orders now coexist

Combat makes **player↔player** a live pair for the first time; the helper
existed but no route called it.

| Pair | Order |
|---|---|
| gang ↔ player | `lockGangAndPlayerForUpdate` (UUID compare) |
| location ↔ player | locations first, always |
| player ↔ player | ascending UUID (`lockPlayersForUpdate`) |

They do not intersect, and combat must not make them. Combat takes **no**
location or gang lock: it *reads* `gang_members` for friendly fire and
`location_id` for co-location — plain reads, not `FOR UPDATE` — and inserts
only `combat_log`, whose FKs are deliberately limited to `players` and `items`
(§4.1).

---

## 9. Testing

### 9.1 Determinism without test scaffolding

The rolls are `randomInt` in a synchronous route, so there is no job seed to
pin an outcome. Rather than inject an RNG — test-only surface inside shipped
code, the shape the `bullets` port explicitly rejected — tests force outcomes
through **item stats**: `accuracy: 100` always hits, `accuracy: 0` never does,
`damageMin == damageMax` fixes damage, `critChance: 100` / `0` pins the crit
branch. Every deterministic assertion comes from a seeded fixture item. Only
the mid-range distribution needs a statistical check, and it gets one loose
sanity assertion, not an exact one.

### 9.2 New test files

Each needs a `vitest.workspace.ts` `include` entry — an unlisted file is
silently never run and looks exactly like a green suite. Each new package needs
a `srcAliases` entry — a missing one grades a src-only edit against a stale
`dist/`.

| File | Proves |
|---|---|
| `combat.test.ts` | HTTP contract: every legality code, hit / miss / crit / armor-absorb / pierce, bullets debited on a miss, `combat_log` rows, both events and their audience |
| `combat-kill.test.ts` | Death: full on-hand cash transferred, bank untouched, `sum(ledger) == balance` both sides, hospital set, `fatal` row, `player.killed` |
| `combat-lock-order.test.ts` | Mutual attack A↔B concurrently — no `40P01` |
| `combat-concurrency.test.ts` | Two attackers, victim at 1 hp — exactly one payout, loser gets `target_hospitalised` |
| `inventory.test.ts` | Equip both slots, unequip via `null`, `wrong_slot`, `not_owned`, `rank_too_low`; use heals to the cap, `already_full`, qty never below 0 |
| `hospital.test.ts` | Discharge cost and clear, `settleHospital` restores full health on expiry, `not_hospitalised`, the 423 gate carries `retry-after` |

**Edited:** `economy-invariant.test.ts` gains kill-transfer and discharge
operations in its 1000-op sweep, driven through `callPluginRoute`
(`test/helpers/plugin-route.ts`, introduced by the `bank` port and reused by
four ports since).

### 9.3 The gate that matters most

**Both concurrency tests must be demonstrated failing before they are
accepted** — `combat-lock-order.test.ts` against a deliberately inverted lock
order, producing a real `40P01`; `combat-concurrency.test.ts` with the lock
removed, producing a double payout.

CLAUDE.md's corollary to rule 6: a concurrency test whose participants all
acquire locks through the same helper proves only the case that was already
safe. The pre-existing M3 deadlock test agreed on ordering by construction and
stayed green straight through a real bug for exactly that reason.

### 9.4 Verification

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Read the **exit code**, not the summary — an unhandled rejection makes vitest
exit non-zero while still printing a passing test count.

Also:
- `npx tsc --build --force apps/server/tsconfig.json` — catches a missing
  `apps/server/tsconfig.json` reference, which otherwise fails only in CI.
- `grep -c "packages/plugins/combat" Dockerfile.server` → 5; same for
  `inventory`.

---

## 10. Explicitly out of scope

| Item | Why |
|---|---|
| `backfire` (attacker self-damage) | Column exists, unused, no behaviour to preserve. A free design slot for later. |
| Kills leaderboard | The existing `respect` / `cash` sorted sets are enough for now. |
| Bounties | Own cluster; unblocked by this work. |
| Detectives / search | Own cluster; unblocked by this work. |
| Blackmarket, trading, shops | Item-economy cluster. This spec ships only own / equip / use. |
| Public kill announcements | A `news.posted` decision, deliberately not a global event audience (§5.6). |
| Balance numbers | Settings exist with defaults; tuning is a separate pass. Intent: cash discharge expensive relative to heal items. |
| Per-gang friendly-fire policy | Considered and rejected (§5.3). |
