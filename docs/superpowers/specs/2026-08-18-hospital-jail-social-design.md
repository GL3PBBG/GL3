# Hospital self-admission and local facility rosters — design

Date: 2026-08-18
Branch: `feat/hospital-jail-social`
Status: approved, not yet implemented

**Post-implementation correction:** §8 below specifies `@gl3/shared` →
`0.1.10`. By the time this branch's DTO task went to publish, the registry
already served both `0.1.10` and `0.1.11`, taken by another session's work
landing concurrently — neither number belongs to this cluster. The version
actually shipped is `0.1.12`; see `docs/STATUS.md`'s "Hospital self-admission
and local facility rosters" section for the corrected record.

## 1. Why

V2's hospital is two things GL3's is not. First, it is a *heal* — a player low
on health checks themselves in, waits, and comes out full. GL3 today only ever
puts you in hospital involuntarily (combat, or a weapon backfire), so a player
sitting at 12 HP has no route back to full except getting killed. Second, both
facilities are *places*: standing in a town, you can see who else is in that
town's hospital or jail, and act on them — pay a stranger's discharge, bail a
gang-mate, or try to bust them out and get jailed yourself for failing.

This cluster adds both. It is the social half of two facilities that currently
only ever talk to one player at a time.

## 2. Where it lives: core, not a plugin

`docs/STATUS.md` records the standing rule — jail and hospital are core state
facilities rather than plugins, because a facility gates *other* plugins'
routes (`accessInJail`, `accessInHospital`) and a plugin cannot make another
plugin's routes refuse a player.

Everything here inherits that. The decisive new fact is that bail, bust and
paid discharge-of-another all need a **release-another-player primitive**.
Exposing "clear any player's sentence" on the plugin ctx would widen the SDK's
trust surface permanently — `publishCore` is already unrestricted by design,
and a second unrestricted lever over other players' state is a worse trade than
keeping three routes in core.

Consequences: no new plugin package, none of the eight workspace registration
sites, no `@gl3/plugin-sdk` bump. `@gl3/shared` takes an additive patch bump for
the new DTOs.

## 3. Routes

All under `requireAuth`. Every body and every param is Zod-parsed at the
boundary. Money crosses the wire as a decimal string.

### 3.1 `POST /api/hospital/checkin`

Free. The cost is time.

```
seconds = (maxHealth − health) × hospital.checkin_seconds_per_hp
```

- 409 `already_hospitalised` if `hospital_until` is live.
- 409 `not_injured` if `health >= maxHealth` — a zero-length stay would
  otherwise be a way to write `health = 0` and immediately settle back, and it
  reads as a no-op to the player either way.
- Writes through the existing `sendToHospital(tx, playerId, seconds)`, which
  sets `health = 0` alongside the deadline and takes the player lock first.
- Reachable while jailed, matching `discharge` — the two sentences are
  independent and neither shortens the other. Checking in does **not** release
  a player from jail and does not extend jail.
- Publishes nothing. The player did this to themselves and holds the response;
  the existing `player.discharged` fires when the stay ends.

Response: `{ health, maxHealth, hospitalised, until, remainingSeconds, dischargeCost }`
— the same shape `GET /api/hospital` already returns, so the web page can
overwrite its cache with the mutation result.

### 3.2 `GET /api/hospital/local`

Patients whose `location_id` equals the caller's, `hospital_until > now()`,
**self excluded** (the caller's own status is the panel above the list).

Per row: `playerId`, `username`, `rankName`, `until`, `remainingSeconds`,
`dischargeCost` (that patient's remaining seconds × the same per-second rate as
your own discharge).

A caller with `location_id = null` gets an empty list, not an error.

This route settles nothing. An elapsed row is filtered out by the `> now()`
predicate, and the sweeper plus the patient's own next request are what clear
it — a roster read must not take write locks on strangers.

### 3.3 `POST /api/hospital/discharge-player` — body `{ playerId }`

Pays another patient out. Same formula as your own discharge
(`remainingSeconds × hospital.discharge_cost_per_second`), charged to **you**,
target healed to their own rank's `maxHealth` and `hospital_until` cleared.

- 400 on a malformed body; 404 `player_not_found`.
- 409 `not_hospitalised` if the target is not (or is no longer) in hospital.
- 409 `wrong_location` if the target is not in the caller's town.
- 409 `insufficient_funds` from `InsufficientFundsError`.
- 409 `self_target` — paying for yourself is `POST /api/hospital/discharge`.

Ledger reason: `hospital.discharge` (unchanged — the payer is the ledger row's
player either way; the row's meaning is "someone bought a discharge").

### 3.4 `GET /api/jail/local`

Inmates at the caller's location, `jailed_until > now()`, self excluded.
Per row: `playerId`, `username`, `rankName`, `until`, `remainingSeconds`,
`bailCost` (`remainingSeconds × jail.bail_cost_per_second`).

### 3.5 `POST /api/jail/bail` — body `{ playerId }`

Charged to the caller, target freed immediately. Same error set as §3.3 with
`not_jailed` in place of `not_hospitalised`. Ledger reason: `jail.bail`.

### 3.6 `POST /api/jail/bust` — body `{ playerId }`

Free to attempt. One seeded roll (`createRng(newSeed()).int(0, 100)`) against
`jail.bust_success_percent`:

- **Success** — target's `jailed_until` cleared. Caller untouched.
- **Failure** — the *caller* is jailed for `jail.bust_fail_jail_seconds` via
  `sendToJail`. The target stays in.

Failure is the whole cost, which is what makes the route safe to leave
uncooldowned and unpriced. Refused with 409 `already_jailed` if the caller is
themselves in jail — a prisoner cannot bust anyone — and with the same
`self_target` / `wrong_location` / `not_jailed` / 404 set as bail.

The seed is generated per request and returned nowhere; it exists so the roll
goes through the repo's one RNG (`game/rng.ts`) rather than `Math.random`. The
route cannot be handed a seed from outside — a client-chosen seed is a
client-chosen outcome. Determinism for tests comes from two places instead: a
pure `bustSucceeds(seed, percent)` unit-tested over fixed seeds, and route
tests that set `jail.bust_success_percent` to `100` or `0`, which decide the
branch regardless of the draw.

## 4. Locks

Every two-player route (`discharge-player`, `bail`, `bust`) opens with ONE
sorted `lockPlayersForUpdate(tx, [callerId, targetId])` as its **first**
statement, before any read of either player's row. That is combat's helper and
combat's ordering, so this adds **no new edge to the lock graph** (rule 6):
the player↔player pair already exists, and one sorted call is exactly what makes
A-bails-B safe against B-bails-A.

The re-read of the target's sentence happens *after* that lock, and it is the
arbiter: two concurrent bails of the same inmate both queue on the lock, the
winner clears `jailed_until`, and the loser's re-read sees `null` and answers
409 `not_jailed` instead of charging a second time. This is the same defect
`test/hospital-concurrency.test.ts` was written for — one discharge, two
`hospital.discharge` ledger rows, and `sum(ledger) == balance` never notices
because the ledger stays internally consistent.

Location is **checked, not locked** — combat's precedent. No route here mutates
a location row, and locking one would add a location→player edge that the
locations-first clusters (bullets, theft, properties, casino) would then have to
be ordered against.

`bust` on failure calls `sendToJail(tx, callerId, …)`, which takes
`lockPlayersForUpdate` on the caller — already held by this transaction, so it
is a no-op, exactly as it is inside the crime worker.

## 5. Events and notifications

**No new `GameEvent` variant.** That is deliberate: a new variant costs four
separate updates (`apps/web/lib/eventCopy.ts`, `apps/web/ws/invalidation.ts`,
the `CORPUS` guard in `test/plugin-ctx-core-events.test.ts`, and the hardcoded
census in `packages/shared/test/events.test.ts`), and every fact this cluster
produces is already expressible:

| What happened | Published | Audience |
|---|---|---|
| Bail / bust frees a target | `player.released` | target |
| Paid discharge frees a patient | `player.discharged` | target |
| Failed bust jails the caller | `player.jailed` (`reason: "bust_failed"`) | caller |
| "X paid your bail" | `notification.created` | target |

All published **after commit** (rule 5), through `publishEvent`. The
notification *row* is inserted inside the transaction via `insertNotification`;
its event follows the commit, and its `actorId` is the **recipient's** id — the
convention `plugins/ctx.ts` documents and `awaitOwnEvent` depends on.

`player.released` and `player.discharged` already carry `actorId = the freed
player`, which is what the web client's invalidation keys off. Nothing about
those handlers changes.

## 6. Settings

Four new keys, admin-edited free text, read through the same defensive parse
`costPerSecond` already uses — blank or malformed falls back to the default
rather than throwing on every request, and a negative value is malformed.

| Key | Default | Meaning |
|---|---|---|
| `hospital.checkin_seconds_per_hp` | `30` | Stay length per missing HP |
| `jail.bail_cost_per_second` | `1000` | Cash per remaining second of sentence |
| `jail.bust_success_percent` | `25` | Clamped to 0–100 |
| `jail.bust_fail_jail_seconds` | `300` | The caller's sentence on a failed bust |

`registerJailRoutes` does not currently receive `settings`; `app.ts` gains that
argument. Like every other `settings` consumer, a change needs a server restart
to take effect.

## 7. Web

- **`/hospital`** — when free and below max health, a "Check yourself in" panel
  showing the computed stay length before you commit. The existing hospitalised
  view is unchanged. Below both, **In this ward**: the local patient list, each
  row with a pay-to-discharge button priced from `dischargeCost` and disabled
  when unaffordable (`canAfford`, as the existing discharge button does).
- **`/jail`** — unchanged self panel, plus **In this cell block**: inmates with
  Bail (priced, affordability-gated) and Bust (free, with the failure
  consequence stated in the row's copy, since it can jail the clicker).
- Both lists are new query keys (`keys.hospitalLocal()`, `keys.jailLocal()`)
  invalidated by the same events as their parent page, plus by their own
  mutations. Neither polls: the roster is not a countdown the tab must keep
  honest, and rows carry `remainingSeconds` for the existing local tick.
- Copy states plainly that checking in blocks crimes, combat and travel until
  the stay ends — the price of the free heal is that `accessInHospital` gates
  hold for its whole duration.

## 8. Schema and packaging

**No migration.** No new table, no new column, no new index — the roster query
filters `location_id` (served by `player_stats_location_idx`) and the partial
`player_stats_hospital_until_idx` / `player_stats_jailed_until_idx` cover the
sentence predicate. `apps/server/test/schema.test.ts`'s FK and index counts are
therefore untouched, and no `apps/migrate` migrator changes: V2 stores no state
this cluster reads that is not already imported.

`@gl3/shared` → **0.1.10**, additive (the roster row schemas, the check-in
response, the bail/bust response DTOs). Published after merge, with approval.
`@gl3/plugin-sdk` needs no bump — nothing on the ctx or the manifest changes.

## 9. Tests

Integration, against real Postgres and Redis. Every new file must also be added
to the matching project's `include` list in `vitest.workspace.ts` — a file that
is not listed there never runs and `npm run verify` stays green without it.

1. **`hospital-checkin.test.ts`** — duration proportional to missing HP; 409 at
   full health; 409 when already hospitalised; allowed while jailed and does not
   shorten the jail sentence; discharge after check-in charges the normal price.
2. **`facility-rosters.test.ts`** — a patient/inmate in your town is listed, one
   in another town is not, you are never in your own list, an elapsed sentence
   is filtered out without being settled, `location_id = null` yields `[]`.
3. **`hospital-discharge-player.test.ts`** — pays and heals; payer debited,
   target's balance untouched; `wrong_location`, `self_target`, `not_hospitalised`,
   `insufficient_funds`.
4. **`jail-bail-bust.test.ts`** — bail frees and charges; with
   `jail.bust_success_percent = 100` the bust frees the target and leaves the
   caller free; with `0` the target stays in and the **caller** is jailed for
   the configured span; a jailed caller cannot bust. Plus a unit test for the
   pure `bustSucceeds(seed, percent)` over fixed seeds, including the 0 and 100
   boundaries.
5. **`facility-concurrency.test.ts`** — two concurrent bails of one inmate:
   exactly one 200, one 409, exactly one `jail.bail` ledger row. Same for two
   concurrent paid discharges of one patient. This is the test that must be
   shown red against a version without the leading `lockPlayersForUpdate`.
6. **Event assertions** filter by their own `actorId` through
   `awaitOwnEvent()` — the channel is global across test files (rule 4).

No new lock-order test file: the pair is player↔player, the helper is
`lockPlayersForUpdate`, and a concurrency test whose participants all lock
through the same helper proves only the case that was already safe. What is
worth proving is §9.5's double-charge, which is a *missing* lock rather than a
mis-ordered one.

## 10. Out of scope

- Gang-mate discounts or free bails within a gang.
- A bust cooldown or a bust cost — failure jails the caller, which is the
  limiter.
- Hospital or jail as a *destination* you travel to; both remain states of a
  player, read against whatever town they are standing in.
- Any change to how combat, crimes or backfire admit people. This cluster adds
  a voluntary door and a window; it does not touch the involuntary ones.
