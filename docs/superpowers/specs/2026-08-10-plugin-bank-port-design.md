# The `bank` port

Status: design, 2026-08-10. Builds on
`docs/superpowers/specs/2026-08-10-plugin-core-events-design.md` (approved,
implemented). Second port on `publishCore`, after `news`.

## Problem

`apps/server/src/game/bank/` — two files, 85 lines — is the fourth `game/*`
module to port to a plugin and the first of the six that the core-event design
unblocked. It publishes one core event (`bank.transacted`), moves money through
`applyBalanceChange` twice, and writes two leaderboard scores.

It is a small module with one property `news` did not have: **three core test
files import its service function directly.** `news` was reachable only over
HTTP, so `apps/server/test/news.test.ts` needed no edit and was the port's
proof. Deleting `game/bank/service.ts` breaks `test/bank.test.ts`,
`test/economy-invariant.test.ts` (the rule-3 `sum(ledger) == balance` sweep) and
`test/leaderboard.test.ts`. How those three keep testing something real is the
main decision here.

Two smaller gaps, both found while scoping:

- **An overdraft inside a plugin is a 500.** `tx.economy.applyBalanceChange`
  throws core's `InsufficientFundsError`, which a plugin package may not import
  (`economy/ledger.ts` is inside `apps/server`). The route loader maps only
  `PluginError`; everything else rethrows into Fastify. So a ported bank cannot
  produce the 409 its predecessor produced.
- **`Dockerfile.server` enumerates every plugin package four times.** The final
  review of the core-events branch recorded the `apps/server/tsconfig.json`
  reference as a Critical, because the root tsconfig having it makes local
  typecheck pass while the CI image build fails. The Dockerfile is the larger
  half of that same trap and is equally unbuildable on this machine.

## Goals

- The bank routes answer from a plugin with byte-identical status codes, error
  strings, response bodies and events.
- The three coupled test files keep exercising bank's real post-port code path,
  not a stand-in.
- The overdraft gap is closed once, in a way the four remaining ports reuse
  without each choosing its own status code.

## Non-goals

- **The gang bank routes.** See §1.
- `InsufficientGangFundsError`. Deferred to the `gangs` port (§4).
- Any change to `GameEventSchema`, `MoneySchema`, or the `@gl3/shared` bank DTOs.

## 1. Scope

**In:** a new package `packages/plugins/bank` (`@gl3/plugin-bank`, plugin id
`bank`, `basePaths: ["/api/bank"]`) serving `POST /api/bank/deposit` and
`POST /api/bank/withdraw`. Two literal-path routes built by one shared handler
factory taking the direction, mirroring `game/bank/routes.ts:12` — **not** one
route with a `:direction` param, which would match paths core's two never
matched. `apps/server/src/game/bank/` is deleted and
`registerBankRoutes` disappears from `app.ts` — no coexistence path, per the
core-event design's non-goals.

**Out: the gang bank routes.** The brief that requested this port assumed `bank`
was the module CLAUDE.md rule 6 is about. It is not. `game/bank/` is
player-only: two `applyBalanceChange` calls against `player_stats`, no `gangs`
row anywhere, no `lockGangAndPlayerForUpdate`. The routes rule 6 describes are
`POST /api/gangs/:gangId/bank/{deposit,withdraw}` at `game/gangs/routes.ts:751`
and `:795`, and they ship with the `gangs` port.

Moving them here would be actively harmful, not merely misfiled: gang↔player
lock ordering would then be owned by two packages that must agree on it forever,
which is the split-brain shape M3's deadlock (`40P01`) already came from once.
`tx.locks.gangAndPlayer` therefore appears nowhere in this port.

**Out: the `@gl3/shared` bank DTOs.** `BankTransactionRequestSchema` becomes
unused server-side once core's route is gone. It stays, matching what the `news`
port did with `PostNewsRequestSchema` — the DTO package is the web client's
contract, not the server's private one. `BankStatusResponseSchema` is still
parsed by `apps/web/src/api/queries.ts:121` and is untouched.

**No `schema.ts`.** Unlike `news` and `ranks`, this plugin mirrors no core
tables:

- `actorName` comes from `ctx.player.username` — the `PlayerSnapshot` field the
  core-events branch added, so no `players` mirror is needed.
- `cash` and `bank` come from the two `applyBalanceChange` **return values**, so
  core's post-commit `SELECT cash, bank FROM player_stats` disappears. Both
  directions touch both columns, so both numbers are always in hand: deposit
  returns cash from its first leg and bank from its second, withdraw the
  reverse.

The port is therefore two legs, one transaction, zero reads.

## 2. Wire contract

Every response is preserved exactly. `bank.test.ts`'s existing `app.inject`
block is the proof and does not change.

| Case | Core today | Plugin |
|---|---|---|
| missing/invalid token | 401 `{"error":"unauthorized"}` | `auth: "player"` → the loader's `app.requireAuth`, which sends the same body (`auth/routes.ts:45`) |
| body is not `{amount:"<integer string>"}` | 400 `{"error":"invalid_request"}` | the loader's zod gate (`plugins/routes.ts:39`), same body |
| `amount <= 0` | 400 `{"error":"amount_must_be_positive"}` | `PluginError("amount_must_be_positive", 400)` thrown in the handler |
| overdraft on either leg | 409 `{"error":"insufficient_funds"}` | catch the SDK error (§4) → `PluginError("insufficient_funds", 409)` |
| success | 200 `{cash,bank}` as decimal strings | same, built from the leg return values |

The positive-amount check stays in the **handler**, not in the body schema. A
zod `.refine()` would be shorter, but the loader answers every schema failure
with `invalid_request` — the distinct `amount_must_be_positive` string would be
silently lost. Nothing in `apps/web` reads it today; it is preserved because the
spec's rule for M5 is that no HTTP response changes, and a port is not the place
to decide an error string is expendable.

`accessInJail` keeps the `route()` default of `true`. Core's bank routes have no
jail gate — `registerBankRoutes` never calls `releaseIfExpired` — so setting it
`false` would add a 423 to a route that has never returned one.

## 3. Event and leaderboard

One buffered core event, published after commit:

```ts
await tx.events.publishCore({
  type: "bank.transacted",
  actorId: playerId,
  actorName: ctx.player.username,
  audience: { kind: "player", playerId },
  direction, amount: amount.toString(),
  cash: cash.toString(), bank: bank.toString(),
});
```

**The audience is private.** `{ kind: "player", playerId }`, as
`game/bank/service.ts:44` has it — not `news`'s `{ kind: "global" }`. Bank state
is not broadcast, and this is the single field most likely to be got wrong by
copying the reference port, so §5 asserts it.

**The leaderboard needs no plugin code.** The core-event design's §B1 made
`tx.economy.applyBalanceChange` buffer a `recordScore` for the kind it changed,
keyed `${kind}:${playerId}` with last-write-wins. Bank changes exactly `cash`
and `bank`, one leg each, so core's two explicit `recordScore` calls are
absorbed by the capability. This is the first port to depend on B1, which is
what makes `leaderboard.test.ts` (§5) part of this port's proof rather than
incidental.

One accepted difference. Core publishes the event and *then* records the two
scores (`service.ts:47-50`); the ctx flushes scores first and events second
(`plugins/ctx.ts:183-199`, matching `game/crimes/worker.ts`). Nothing asserts
the interleave, and the ctx order is the safer one: a client that reacts to
`bank.transacted` by re-reading the leaderboard sees the new score, which core's
order does not guarantee.

## 4. `InsufficientFundsError` in the SDK

`packages/plugin-sdk/src/errors.ts` gains a third class:

```ts
export class InsufficientFundsError extends Error {
  constructor(
    readonly playerId: string,
    readonly kind: PluginBalanceChange["kind"],
  ) {
    super(`insufficient ${kind} for player ${playerId}`);
    this.name = "InsufficientFundsError";
  }
}
```

`plugins/ctx.ts`'s `applyBalanceChange` wrapper catches core's and rethrows the
SDK's, carrying `playerId` and `kind` through. The `try` wraps **only** the call
to core's `applyBalanceChange`: any other error propagates untouched, and
`bufferScore` stays outside it, so a failed leg buffers no score.

This is the same shape as the gaps the core-event design labelled M6 and M7 — a
capability that leaves its caller an obligation the caller cannot discharge.
`applyBalanceChange` can fail in a way the plugin must turn into a specific HTTP
response, and gave it nothing to catch.

**The loader must not map this centrally.** Three modules turn the same error
into 409 `insufficient_funds` (`bank`, `travel`, `bullets`) but `gangs` turns it
into **400 `insufficient_cash`** (`game/gangs/routes.ts:789`). A loader-level
mapping would have to change one of those. Exporting a catchable class instead
lets each port keep its own status and string, which is the whole requirement.

**Scope held to `applyBalanceChange`.** `applyGangBalanceChange` throws
`InsufficientGangFundsError`, which has the identical gap and no caller until
the `gangs` port. It is deferred there, on the same reasoning the core-event
design used to defer the ports themselves: the plan that can prove a capability
end to end is the plan that should add it. `addExp` and `applyExpAndRankUp` only
ever credit, and are not wrapped.

## 5. Testing

Integration tests against real Postgres and Redis. No mocks on DB, queue or bus
paths.

### The helper

`apps/server/test/helpers/plugin-route.ts` gains:

```ts
callPluginRoute(manifest, method, path, {
  db, redis, leaderboardPrefix, playerId,
  body?: unknown,    // default {}
  params?: unknown,  // default {} — bank has none
})
```

It builds the player snapshot with `loadSnapshot` **exported from
`plugins/routes.ts`** rather than a private copy — a test's ctx must not be able
to drift from the one the real route builds — then creates the ctx via
`createPluginCtx({ db, redis, queues: new Map(), settings: {},
leaderboardPrefix }, { pluginId: manifest.id, player, job: null, filters:
manifest.filters })`. It looks the route up by `method` + `path` and throws if
the manifest has no such route (a typo'd path must fail loudly, not silently
test nothing), runs that route's own `params` and `body` zod schemas against the
caller's values, and calls the handler. A `PluginError` propagates to the caller
rather than becoming a status.

It is deliberately **not** the HTTP contract, and its own docblock says so: no
jail gate, no `PluginError` → status mapping, no auth. Those stay covered by
`bank.test.ts`'s `app.inject` block. A helper that resembles the loader without
being it is how a suite starts proving the wrong thing.

The helper is generic over any manifest, and the `travel`, `bullets`, `crimes`
and `gangs` ports face the same coupled-test problem — `economy-invariant.test.ts`
alone calls into three of them.

### Changes to the three coupled files

- **`test/bank.test.ts`** — the four in-process cases move to the helper and
  keep their coverage exactly: two ledger legs plus the event, withdraw,
  overdraft leaves both balances and the ledger untouched, and two concurrent
  withdrawals against a tight balance serialize so exactly one succeeds. One
  assertion is added that core never had: `event.audience` equals
  `{ kind: "player", playerId }` (§3). The `app.inject` block is unchanged —
  `buildApp`'s default path loads `CORE_PLUGINS`, and `bank` declares no jobs,
  so it clears the guard at `app.ts:104`.
- **`test/economy-invariant.test.ts`** — the `bank` op calls the helper with the
  file's own `leaderboardPrefix`. Its catch list swaps core's
  `InsufficientFundsError` for a `PluginError` whose `code` is
  `insufficient_funds`; the other four ops still catch core classes directly,
  because their modules are still core. The 1000-op sweep keeps running bank's
  real post-port path.
- **`test/leaderboard.test.ts`** — the one `performBankTransaction` call becomes
  a helper call threading `PREFIX`. This is what proves §3's claim that B1
  covers both kinds.

### Proof the tests can fail

A green test never shown red proves nothing (CLAUDE.md, working method). Three
named reds to demonstrate, each reverted after:

1. Remove the `amount <= 0` guard → the zero and negative 400 cases fail.
2. Remove the `insufficient_funds` catch → the overdraft returns 500, not 409.
3. Remove one `applyBalanceChange` leg → the two-ledger-row assertion and the
   `sum(ledger) == balance` invariant both fail.

Every test asserting on `game:events` filters by its own `actorId` via
`awaitOwnEvent` (CLAUDE.md rule 4).

## 6. Registration

Eight files. Five fail silently or remotely if missed, which is why this is a
numbered list in the plan rather than prose.

1. `packages/plugins/bank/{package.json,tsconfig.json,src/index.ts}` — new,
   copied from `packages/plugins/news`.
2. `apps/server/package.json` → `"@gl3/plugin-bank": "*"`, then `npm install`
   to create the workspace link.
3. `apps/server/tsconfig.json` `references` — **omitting this fails only in
   CI's image build**, because the root tsconfig's own reference makes
   `npm run typecheck` pass regardless. The Critical from the core-events
   branch's final review.
4. root `tsconfig.json` `references`.
5. `vitest.workspace.ts` `srcAliases` — **omitting this fails nothing and
   silently grades the last `tsc --build`**, since the package ships a
   populated `dist/`. This bit the `notifications` port; the file's own header
   documents it.
6. `apps/server/src/plugins/core-plugins.ts` → add to `CORE_PLUGINS`.
7. `apps/server/src/app.ts` → delete the `registerBankRoutes` import and call.
8. `Dockerfile.server` → **four separate COPY sites** (builder manifest,
   builder tsconfig+src, runtime manifest, runtime dist) plus the header
   comment that enumerates the packages. **CI-only failure**; Docker cannot run
   on this machine.

Docs: `docs/STATUS.md` (ports 3→4, remaining 6→5, the new SDK error, the new
test helper) and `CLAUDE.md`'s current-state paragraph.

### Verification

- `npx tsc --build --force apps/server/tsconfig.json` — the exact command
  `Dockerfile.server:83` runs. Unlike `npm run typecheck`, which builds from the
  root tsconfig, this one fails on a missing `apps/server/tsconfig.json`
  reference, so it catches item 3 locally. It does **not** catch item 8; nothing
  local does.
- `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` — judged by exit code,
  never by the printed summary (CLAUDE.md, environment).

## 7. Sequencing after this port

`bullets` and `travel` next: both are single-player money paths that reuse §4's
SDK error and §5's helper with nothing new. `mail` after those. `crimes` and
`gangs` stay last — the crime worker's deliberate event ordering and replay
semantics, and the gang lock ordering this port explicitly declined to take on.
