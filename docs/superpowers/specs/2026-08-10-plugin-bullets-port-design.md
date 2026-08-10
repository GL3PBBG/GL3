# Design: port `bullets` to `@gl3/plugin-bullets`

Date: 2026-08-10
Status: approved, not yet implemented
Predecessors: `2026-08-10-plugin-bank-port-design.md`,
`2026-08-10-plugin-core-events-design.md`

---

## 1. What this ports, and why it is next

`apps/server/src/game/bullets/` (`routes.ts`, `service.ts`) becomes
`packages/plugins/bullets/`. `POST /api/bullets/buy` answers from the plugin;
the core directory is deleted.

`bullets` is the fifth of twelve `game/*` modules to port and the first of the
five that remained after `bank`. It was chosen over `travel` because it is the
harder of the two and everything it proves, `travel` reuses: it is the **first
caller of `tx.locks.location`**, the first plugin to write core-owned
non-money columns, and the only remaining single-player money path with a
shared, contended resource behind it.

Scope is `bullets` alone. `travel` gets its own spec. The two lock a location
and a player in **mirror-image** ways — bullets takes an explicit location
lock then the player lock; travel takes the player lock and reaches
`locations` implicitly through a `location_id` FK update — and putting both
under one plan is the split-brain shape M3's deadlock came from.

## 2. Package shape

`packages/plugins/bullets/` → `@gl3/plugin-bullets`, manifest id `bullets`,
`version: "1.0.0"`, `basePaths: ["/api/bullets"]`, one route.

It declares **no `menu`, no `pages`, no `events`, and no `jobs`**. The first
three are required by `plugin-manifest-endpoint.test.ts:87`, which asserts a
no-arg boot answers `GET /api/plugins` with exactly
`{ menu: [], pages: [], events: [] }`; the fourth is required by `buildApp`,
which throws at boot if a core plugin declares `jobs` (no queue-name prefix on
that path). Both constraints already bind every core plugin.

### 2.1 `src/schema.ts` — mirrors, not ownership

Read/write mirrors of two core-owned tables. Column names and types match
`apps/server/src/db/schema/identity.ts:56` and `content.ts:27` exactly, which
is what lets `tx.db.select` / `tx.db.update` type and serialise correctly.
Neither is listed in the manifest's `tables` map and neither gets a migration
here — core already owns and migrates both. This is the pattern
`packages/plugins/ranks/src/schema.ts` and `news/src/schema.ts` established;
the loader enforces naming and prefix rules only on tables a manifest
*declares*.

```ts
playerStats = pgTable("player_stats", {
  playerId:   uuid("player_id").primaryKey(),
  bullets:    bigint("bullets", { mode: "bigint" }).notNull(),
  locationId: uuid("location_id"),
})

locations = pgTable("locations", {
  id:          uuid("id").primaryKey(),
  bulletStock: integer("bullet_stock").notNull(),
  bulletCost:  bigint("bullet_cost", { mode: "bigint" }).notNull(),
})
```

`bullets` and `bulletCost` are `bigint`; `bulletStock` is `integer`. Getting
either wrong is a serialisation bug, not a type error — `bullets` crosses the
wire as a decimal string through `MoneySchema`.

**This is the first plugin to write a core-owned column that no ctx
capability covers.** `bank` routed every write through
`tx.economy.applyBalanceChange`; `news` writes only `game_news`, a table core
no longer touches. `bullets` updates `player_stats.bullets` and
`locations.bullet_stock` directly through `tx.db`. The alternative — growing
the SDK a `tx.inventory.addBullets` / `tx.locations.takeStock` pair — was
rejected: two members whose only caller is one plugin, encoding
game-specific concepts into a generic SDK, which is the objection that made
`profile` a deliberate non-port. The consequence, stated plainly: the schema
isolation rule is compiler-enforced for *relational queries* (`PluginDbTx`
omits `query`) and for *money* (`applyBalanceChange`), and is a convention
for everything else. A plugin that mirrors a table can write it.

### 2.2 `src/index.ts` — the route

Body schema is restated rather than imported (`@gl3/shared` is off-limits to
a plugin package), matching `BuyBulletsRequestSchema` exactly:

```ts
z.object({ quantity: z.number().int().positive() })
```

`accessInJail: false` — bullets is an action and gates on jail. This is the
first core plugin to set it; `bank`, `news`, `ranks` and `notifications` all
take the `true` default.

## 3. The transaction

Ordered as core's `service.ts:31-49`, step for step.

| # | Step | Notes |
|---|---|---|
| 1 | `select { locationId } from player_stats where playerId` | **Unlocked**, preserved verbatim — see §6 |
| 2 | falsy `locationId` → `PluginError("no_location", 409)` | |
| 3 | `await tx.locks.location(locationId)` | **Location lock precedes any player lock** |
| 4 | `select` the `locations` row; missing → `no_location` | Core's stale-reference guard, `service.ts:38` |
| 5 | `bulletStock < quantity` → `PluginError("insufficient_stock", 409, { available: bulletStock })` | `PluginError.extra` carries `available` |
| 6 | `cost = bulletCost * BigInt(quantity)` | `bigint` throughout, no floating point |
| 7 | `tx.economy.applyBalanceChange({ amount: -cost, kind: "cash", reason: "bullets.purchase", refId: locationId })` | Takes the **player** lock |
| 8 | catch `InsufficientFundsError` → `PluginError("insufficient_funds", 409)` | The SDK error `bank` added |
| 9 | `update locations set bulletStock = <value read at step 4> - quantity` | |
| 10 | `update player_stats set bullets = bullets + quantity` `.returning({ bullets })` | |
| 11 | `tx.events.publishCore({ type: "bullets.purchased", … })` | Buffered; flushed after commit |
| 12 | return `{ status: 200, body: { cash, bullets, bulletStock: <read> - quantity } }` | Both money fields `.toString()` |

The event is byte-identical to core's `service.ts:52-58`: `actorId` the
player, `actorName` from `ctx.player.username`, `audience`
`{ kind: "player", playerId }`, plus `locationId`, `quantity`, `cost`, `cash`
and `bullets`. `id` and `at` are filled by the SDK, as core filled them by
hand.

### 3.1 Lock order is the defining constraint

Core locks **location, then player**. `tx.locks.location`'s own
documentation (`packages/plugin-sdk/src/ctx.ts:150-153`) names that as the
global order for any path touching a location alongside a player, and
`docs/STATUS.md`'s "what M3 established" section names inverting it as a way
to reintroduce SPEC §2.3's deadlock class.

`tx.economy.applyBalanceChange` takes the player lock internally. Therefore
**step 3 must precede step 7**, and no call that touches a player row may be
hoisted above the location lock. This is not stylistic; a reviewer checking
only explicit lock calls will not see it, because step 7's lock is implicit
in the ctx method.

### 3.2 Three deliberate differences from core

Same shape `bank` established, and for the same reasons:

1. **No post-commit `SELECT cash, bullets`.** Core re-reads both inside the
   transaction (`service.ts:46`). Step 7 returns the new cash and step 10's
   `.returning()` yields the new bullets, so both numbers are already in
   hand. One fewer round trip, identical values.
2. **No `players` read for `actorName`.** Core selects it after commit
   (`service.ts:51`); `ctx.player.username` has it. Between this and the
   previous point, the plugin needs no `players` mirror.
3. **The event is buffered, not published by hand.** `publishCore` buffers
   during the transaction and the loader flushes after commit, discarding on
   rollback — CLAUDE.md rule 5 made unrepresentable rather than merely
   documented.

## 4. Two behaviour changes this port makes, deliberately

Both were found during design and are accepted. Neither is incidental; each
gets a test.

### 4.1 The `retry-after` header — a loader gap, fixed here

Core's route sets `reply.header("retry-after", String(jail.remainingSeconds))`
before the 423 (`game/bullets/routes.ts:19`). The plugin loader's jail gate
(`apps/server/src/plugins/routes.ts:28-33`) sends the 423 body but **no
header**, so a naive port would silently drop it. `bullets.test.ts:147`
asserts only `toMatchObject({ error: "jailed" })`, so the suite would stay
green through the loss.

**Fix in the loader**, within this port's work, proven by a `retry-after`
assertion added to `bullets.test.ts`'s 423 case — which must be demonstrated
failing against the unfixed loader before the fix lands. One line serves
`bullets`, `travel` and `crimes` — all three set the same header
(`game/travel/routes.ts:42`, `game/crimes/routes.ts:55`). No plugin today
sets `accessInJail: false`, so no existing behaviour changes. The result
widens the byte-identical claim rather than weakening it.

### 4.2 The cash leaderboard starts updating

Core's bullets service never calls `recordScore` — verified: the only callers
are `game/crimes/worker.ts:149,153` and `plugins/ctx.ts:208`.
`tx.economy.applyBalanceChange` buffers one leaderboard write per changed
kind and flushes it after commit (core-events design §B1). So the ported
route begins `ZADD`-ing the player's cash score where core did not.

There is no opt-out, and none should be added: an SDK flag to suppress the
buffer would exist only to preserve a core inconsistency (`bank` and `crimes`
record cash; `bullets` and `travel` do not), and every future port would have
to decide which way to set it.

Accepted as a fix. `bullets.test.ts` gains an explicit leaderboard assertion
so the behaviour is proven rather than incidental — the same treatment
`bank`'s port gave the equivalent effect via `test/leaderboard.test.ts`.

## 5. Errors and the wire contract

Every status code, error string and response body is unchanged:

| Condition | Response | Source |
|---|---|---|
| Success | `200 { cash, bullets, bulletStock }` | handler return |
| `quantity` not a positive integer | `400 { error: "invalid_request" }` | loader's zod gate |
| No location | `409 { error: "no_location" }` | `PluginError` |
| Stock too low | `409 { error: "insufficient_stock", available }` | `PluginError.extra` |
| Cannot afford | `409 { error: "insufficient_funds" }` | `PluginError` |
| Jailed | `423 { error: "jailed", remainingSeconds }` + `retry-after` | loader gate + §4.1 |
| No token | `401` | `app.requireAuth` |

`NoLocationError` and `InsufficientStockError` are **deleted** with
`game/bullets/`. They were internal classes; the wire codes replace them.

## 6. Carried forward, not fixed: the read-then-lock window

Step 1 reads `player_stats.location_id` **without a lock**, then step 3 locks
the location. A `travel` committing in that window means the player buys at a
location they have already left. Core has this exact window
(`service.ts:32-36`); the port preserves it.

Closing it here was rejected. Locking the player first inverts the mandated
location→player order and reintroduces the deadlock class. Re-reading
`location_id` after taking the location lock is safe but is a behaviour
change smuggled into a port — and it is precisely the unchanged
`app.inject` block that makes this port's correctness provable, a property
that only holds while behaviour is unchanged.

Recorded in `docs/STATUS.md`'s watch items. `travel` is the natural place to
close it, since it owns the other side of the race.

## 7. Testing

`apps/server/test/bullets.test.ts`'s `describe("POST /api/bullets/buy")`
block (lines 98-154) is the proof and is **unchanged**, except for the two
additions §4 requires: a `retry-after` assertion on the 423 and a leaderboard
assertion on the happy path. It covers the happy path, three 400 shapes,
`no_location`, `insufficient_stock`, `insufficient_funds`, the 423 and the
401 — every row of §5.

The `describe("performBulletsPurchase")` block (lines 29-96) imports the
service directly and must move. All five tests convert to `callPluginRoute`
(`test/helpers/plugin-route.ts`), which drives the real handler in-process
against real Postgres and Redis with the route's own zod schemas.
`instanceof` assertions become code assertions:

```
rejects.toBeInstanceOf(NoLocationError)
  → rejects.toMatchObject({ code: "no_location", status: 409 })
```

This asserts the wire contract rather than an internal class name. The helper
is explicitly **not** the HTTP contract — no jail gate, no auth, no
`PluginError` → status mapping — which is why the `app.inject` block stays.

**The concurrency test (lines 70-95) is the one that matters** and must
survive intact in behaviour: two players buying against a stock of 1, exactly
one succeeding, stock never negative, exactly one ledger row. It is the only
proof that the location lock does its job, and it has no HTTP equivalent. Two
concurrent `callPluginRoute` calls replace the two `performBulletsPurchase`
calls; the rejected one is now a `PluginError` with code
`insufficient_stock`.

`apps/server/test/economy-invariant.test.ts` also imports the service
(`:12`, `:116`, `:133`). Its 1000-op `sum(ledger) == balance` sweep converts
the same way `bank` did at `:109` — `callPluginRoute(bulletsPlugin, "POST",
"/api/bullets/buy", …)` — and its expected-rejection filter at `:131-139`
gains `insufficient_stock` and `no_location` to the `PluginError` clause it
already has for `insufficient_funds`. Both core classes drop out of the
import list.

Every test must be demonstrated failing before being accepted.

## 8. Registration sites

A new plugin package has eight registration sites, three of which fail
silently or only in CI (CLAUDE.md). All eight, with the current `bank`
entries as the template:

1. `packages/plugins/bullets/` — `package.json`, `tsconfig.json`, `src/`
2. `apps/server/package.json:13` — `"@gl3/plugin-bullets": "*"`, then `npm install`
3. `apps/server/tsconfig.json:9` — a `references` entry. **Fails only in CI.**
   Catch locally with `npx tsc --build --force apps/server/tsconfig.json`
4. root `tsconfig.json` — a `references` entry after line 9
5. `vitest.workspace.ts:36` area — a `srcAliases` entry. **Fails nothing**;
   silently grades a src-only edit against a stale `dist/`
6. `apps/server/src/plugins/core-plugins.ts` — import and add to `CORE_PLUGINS`
7. `apps/server/src/app.ts:8,65` — delete `registerBulletsRoutes`
8. `Dockerfile.server` — **four** COPY sites (`:51`, `:69-70`, `:106`, `:120`)
   plus the three comment blocks at `:7`, `:15-16`, `:19` and `:98`.
   **Fails only in CI.**

## 9. Out of scope

- `travel`, `crimes`, `mail`, `gangs` — their own specs.
- Closing the §6 race.
- Any change to `locations` seeding, `bullet_cost` pricing, or the absence of
  a per-location restock mechanism. V2 had none and GL3 inherits that.
- The three Minors carried forward from the `bank` branch review
  (`docs/STATUS.md`); none is in code this port touches.
