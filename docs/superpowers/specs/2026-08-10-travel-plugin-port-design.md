# Design: port `travel` to `@gl3/plugin-travel`

Date: 2026-08-10
Status: approved, not yet implemented
Predecessors: `2026-08-10-plugin-bullets-port-design.md`,
`2026-08-10-plugin-bank-port-design.md`,
`2026-08-10-plugin-core-events-design.md`

---

## 1. What this ports, and why it is next

`apps/server/src/game/travel/` (`routes.ts`, `service.ts`) becomes
`packages/plugins/travel/`. `GET /api/locations` and
`POST /api/travel/:locationId` answer from the plugin; the core directory is
deleted.

`travel` is the sixth of twelve `game/*` modules to port, and the first port
whose primary purpose is not the port. It owns the other half of the
location↔player race the `bullets` port recorded and deliberately left open
(`docs/STATUS.md`, watch item "The bullets purchase reads
`player_stats.location_id` unlocked"). Both halves — the stale read and the
`40P01` deadlock — close here, or they do not close at all: no other remaining
module touches both a `locations` row and a `player_stats` row.

## 2. Correcting the constraint STATUS recorded

`docs/STATUS.md` states the hard constraint as: `performTravel` must take
`tx.locks.location(toLocationId)` before the player lock.

That closes the deadlock half. It does **not** close the staleness half, and
the design must not inherit the assumption that it does. A buy at L holds
`locations[L]` and then wants `player_stats[P]`. A travel **out of** L locks
the *destination* C and `player_stats[P]` — it never touches `locations[L]`,
so nothing makes it wait for the buy. It commits inside the buy's window and
the buy charges at a location the player has already left. Staleness survives.

Travel must therefore lock **both** location rows — source and destination —
before the player row. That is the constraint this design adopts; §4 states
it in full.

## 3. Package shape

`packages/plugins/travel/` → `@gl3/plugin-travel`, manifest id `travel`,
`version: "1.0.0"`.

```
basePaths: ["/api/locations", "/api/travel"]
routes:    [listRoute, travelRoute]
```

First port to claim two base paths. `plugins/validate.ts:167` already supports
it: the array is checked for cross-plugin overlap and every route path must be
contained in one of the entries.

No `menu`, no `pages`, no `events`, no `jobs` — the first three because
`plugin-manifest-endpoint.test.ts:87` asserts a no-arg boot answers
`GET /api/plugins` with exactly `{ menu: [], pages: [], events: [] }`, the
fourth because `buildApp` throws at boot when a core plugin declares `jobs`.

`src/schema.ts` restates `locations` and `playerStats`; `@gl3/shared` is
off-limits to a plugin package, so the `IdSchema` UUID validator is restated
locally too, exactly as `bullets` restated `BuyBulletsRequestSchema`.

### 3.1 `listRoute` — `GET /api/locations`

`accessInJail: true` (the default; core runs no jail check on this route).
Reads `playerStats.locationId`, all `locations`, and
`ctx.cooldown.peek("travel", playerId)`. Response body is unchanged from
`game/travel/routes.ts:27-33`, money as decimal strings.

### 3.2 `travelRoute` — `POST /api/travel/:locationId`

`accessInJail: false`. The loader (`plugins/routes.ts:25-36`) runs
`releaseIfExpired` and answers 423 with the `retry-after` header, which is
what core's route did inline.

`params: z.object({ locationId: <restated IdSchema> })`. The loader zod-parses
params before the handler; a malformed UUID is 400 `invalid_request`, never a
Postgres error.

## 4. Lock protocol

The whole point of the port. One attempt, retried at most 3 times:

1. **Outside the transaction:** load the destination row. Absent → 404
   `location_not_found`. Deliberately before the cooldown claim, so a typo
   costs the player nothing — core's ordering (`routes.ts:50-52`).
2. **Outside the transaction, attempt 0 only:**
   `ctx.cooldown.acquire("travel", playerId, destination.travelCooldownSeconds)`.
   Lost → 429 `on_cooldown`, body `{ error, retryAfter }`, header
   `retry-after: max(peek, 1)`. Retries do not re-acquire; the cooldown is
   held across the whole call.
3. **Outside the transaction:** unlocked pre-read of
   `player_stats.location_id` → `expectedFrom`. Equal to the destination →
   409 `already_there`, no locks taken, cooldown released.
4. **In the transaction:** `tx.locks.locations([expectedFrom, toLocationId])`
   — nulls dropped, deduped, sorted ascending. `expectedFrom === null` is the
   player's first-ever travel (registration never sets a starting location),
   so only the destination is locked.
5. **In the transaction:** `tx.locks.player([playerId])`. Explicit, because a
   zero-cost travel never calls `applyBalanceChange` and would otherwise hold
   no player lock at all.
6. **In the transaction:** re-read `location_id` under that lock →
   `actualFrom`. If `actualFrom !== expectedFrom`, throw the plugin-internal
   `LocationMovedRetry`, roll the transaction back, and retry from step 3. If
   `actualFrom === toLocationId`, 409 `already_there`.
7. **In the transaction:** re-read the destination's `travelCost` under the
   lock. If `> 0`, `tx.economy.applyBalanceChange({ amount: -cost, kind:
   "cash", reason: "travel.cost", refId: destination.id })`. The SDK's
   `InsufficientFundsError` is caught and rethrown as 409
   `insufficient_funds` — the loader maps no status for it, by design
   (`plugin-sdk/src/errors.ts:36-47`).
8. **In the transaction:**
   `UPDATE player_stats SET location_id = … RETURNING cash`. The implicit
   `FOR KEY SHARE` this takes on the destination's `locations` row lands on a
   row this transaction already holds `FOR UPDATE`, so it is a no-op against
   ourselves rather than a lock-order hazard. `.returning()` replaces core's
   post-commit re-read (`service.ts:53-54`), following the `bullets`
   precedent.
9. **In the transaction:** `tx.events.publishCore({ type: "player.travelled",
   … })` with `audience: { kind: "player", playerId }` and
   `fromLocationId: actualFrom`. Buffered by the ctx, published after commit,
   discarded on rollback — CLAUDE.md rule 5 is unrepresentable here.
10. Any failure that **ends the call** after step 2 releases the cooldown,
    logging and continuing if the release itself throws (core's
    `routes.ts:66-70`). A `LocationMovedRetry` does not end the call and does
    not release it — the cooldown is claimed once and held until the call
    returns, success or failure.
11. Three attempts exhausted → 409 `location_changed`. See §8.

### 4.1 Why this closes both halves

Every path in the game that touches a `locations` row and a `player_stats` row
now takes **locations before players**:

- `bullets`: `locks.location(current)` → `applyBalanceChange` (player lock).
- `travel`: `locks.locations([from, to])` → `locks.player`.

A buy at L holds `locations[L]`. A travel **out of** L must take
`locations[L]` at step 4 and blocks, so the buy's `location_id` cannot go
stale underneath it. A travel **into** L blocks on the same row. The ABBA
cycle documented at `economy/ledger.ts:79-98`,
`plugin-sdk/src/ctx.ts:145-156` and `plugins/bullets/src/index.ts:42-56` no
longer has an edge to close on, and both STATUS watch items close together.

### 4.2 Why the pre-read is sound

Step 3 reads `location_id` without a lock — the same shape this design is
closing in `bullets`. It is sound here only because of step 6: the value is
re-read under the player lock and the transaction is abandoned if it moved.
A committed travel therefore always held the `locations` row it actually
moved the player off. The unlocked read is a *hint used to choose which rows
to lock*, never a value acted on.

The retry path is reachable only by one player racing themselves — two
concurrent travels for the same player — which the Redis travel cooldown
already makes rare but does not make impossible. Three attempts, then a clean
409; no unbounded loop.

The retry lives in the plugin handler, wrapping `ctx.transaction`, not in the
SDK. One caller today; `crimes` and `gangs` can copy the shape if they ever
need it.

## 5. SDK and core changes

Three, all small:

1. **`tx.locks.locations(ids: string[])`** — declared in
   `packages/plugin-sdk/src/ctx.ts:157`, wired in
   `apps/server/src/plugins/ctx.ts:158`, backed by a new
   `lockLocationsForUpdate(tx, ids)` in `economy/ledger.ts` that drops nulls,
   dedupes, and locks in one statement ordered by id ascending.
   `locks.location(id)` stays for `bullets`; `locations([a])` is equivalent to
   `location(a)`, so no shipped port changes.
2. **`PluginError` gains an optional 4th constructor argument
   `headers?: Record<string, string>`**, applied by `plugins/routes.ts:60`
   before `send`. Travel is the first port needing 429 + `retry-after`; the
   `retry-after` support that shipped ahead of the ports covers only the 423
   jail case, which the loader sets itself. Optional argument, so the five
   shipped plugins are untouched.
3. **Three doc comments are rewritten.** `economy/ledger.ts:79-98`,
   `plugin-sdk/src/ctx.ts:145-156` and `plugins/bullets/src/index.ts:42-56`
   currently assert that this deadlock exists, is pre-existing, and is not
   theirs to fix. Once it is fixed those comments actively mislead the next
   porter. They are replaced with the settled rule: *locations before
   players; several locations only through `locks.locations`*.

## 6. Registration sites

Eight, three of which fail silently or only in CI (CLAUDE.md, Conventions):

1. `packages/plugins/travel/`
2. `apps/server/package.json` + `npm install`
3. `apps/server/tsconfig.json` references — **fails only in CI**
4. root `tsconfig.json` references
5. `vitest.workspace.ts` `srcAliases` — **fails nothing**, silently grades
   against a stale `dist/`
6. `plugins/core-plugins.ts`
7. delete `app.ts:15,70` and delete `apps/server/src/game/travel/`
8. **five** COPY lines in `Dockerfile.server` — **fails only in CI**

Local checks: `grep -c "packages/plugins/travel" Dockerfile.server` → 5, and
`npx tsc --build --force apps/server/tsconfig.json` (the exact command the
image build runs).

## 7. Testing

### 7.1 Deadlock regression — `test/travel-lock-order.test.ts`

Deterministic, both participants driving their real shipped handlers, and —
as `docs/STATUS.md` requires — **not** acquiring their locks through the same
helper: `bullets` uses `locks.location` + `applyBalanceChange`, `travel` uses
`locks.locations` + `locks.player`. The test's own transaction is a scheduler,
not a third lock-order participant.

Setup: locations L and C, player P at L with cash.

1. A test-owned transaction takes `player_stats[P] FOR UPDATE` and holds it.
2. Start a travel C→L. Under the old (player-first) order it queues on the
   player row; under the new order it takes `locations[L]` and `locations[C]`
   first, then queues.
3. Poll `pg_locks` until that waiter is visible. No sleeps, no timing
   assumptions — CLAUDE.md, "flaky means broken".
4. Start a buy at L through the real `bullets` handler. It takes
   `locations[L]` if free, then queues on the player row **behind** the
   travel (Postgres lock queues are FIFO).
5. The test transaction commits.
   - **Old order:** travel wakes holding `player_stats[P]`, needs
     `locations[L]` — held by the buy, which is waiting on the player row.
     `40P01`.
   - **New order:** the buy never obtained `locations[L]` at step 4 and holds
     nothing. Travel completes, releases, the buy follows. Green.

**Proof the test can fail is a required plan step**, not an optional one: a
scratch revert of travel to player-first order, the `40P01` captured, the
revert discarded. CLAUDE.md's working method — "a green acceptance test that
was never shown turning red proves nothing" — and rule 6's corollary about
the M3 deadlock test that stayed green by construction.

### 7.2 Other tests

- `test/travel.test.ts` rewritten off the deleted `performTravel` onto
  `callPluginRoute`, plus an `app.inject` parity block asserting paths,
  statuses, error strings and bodies against core's — the `bullets`
  precedent.
- A retry-path test that forces `LocationMovedRetry` by moving the player
  between the pre-read and the lock, asserting the travel still commits and
  the ledger still balances.
- `test/economy-invariant.test.ts:12,113` switched off the direct
  `performTravel` import onto the plugin route, plus
  `expect(succeeded.travel).toBeGreaterThan(0)` — the coverage assertion
  `050bb50` added for `bullets`, for the same reason: the accept-list would
  otherwise let a regression that failed every travel pass silently.

## 8. Deviations from byte-identical behaviour

Stated here rather than smoothed over:

- **Lock order changes.** That is the purpose of the port. Invisible to
  clients; visible only as the absence of a 500.
- **New 409 `location_changed`**, after three exhausted retries. No core
  equivalent. Reachable only by the same player racing themselves past the
  Redis cooldown.
- **Cash comes from `.returning()`** on the `player_stats` update rather than
  a post-commit re-read. Same value, one fewer round trip.

Everything else is identical: paths, status codes, error strings, response
bodies, and the `player.travelled` event envelope.

## 9. Out of scope

`crimes`, `mail` and `gangs` — each gets its own spec. No change to
`bullets`' handler beyond its doc comment: its unlocked pre-read of
`location_id` becomes harmless once travel holds the source row, so the code
that read wrong is left alone and the comment explaining why is corrected.
