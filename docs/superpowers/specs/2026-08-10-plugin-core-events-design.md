# Plugin core events and capability-owned side effects

Status: design, approved 2026-08-10. Supersedes the "event envelope" blocker
recorded in `docs/STATUS.md` and in the M5 module-ports ledger.

## Problem

`ctx.transaction`'s only publish path is `tx.events.publish(...)`, which wraps
everything in the `plugin.event` envelope (`apps/server/src/plugins/ctx.ts`,
`toEnvelope`). Seven of the twelve `game/*` modules queued for porting — `news`,
`bank`, `bullets`, `travel`, `crimes`, `mail`, `gangs` — publish core typed
variants of `GameEventSchema` (`packages/shared/src/events.ts`). A port that
re-emitted `bank.transacted` as `plugin.event` would change the wire contract,
break the web client's typed handling, and break any test filtering on the event
type. So all seven stayed unported.

Two smaller gaps block the same ports, found by the module-ports final review:

- **M6** — a plugin that moves money through `tx.economy.*` leaves the Redis
  leaderboard stale. Core's own callers (`game/bank/service.ts`,
  `game/crimes/worker.ts`) call `recordScore` themselves after commit; a plugin
  has no `recordScore` and no way to reach one.
- **M7** — `tx.notify` inserts a notification row but publishes no
  `notification.created`, so the notification is invisible until the client's
  next poll. Core's two gang-invite notification sites (`game/gangs/routes.ts`)
  always pair the two.

## The blocker is thinner than recorded

The isolation rule — a plugin package may import only `@gl3/plugin-sdk`, `zod`
and `drizzle-orm` — binds *plugin packages*. It does not bind the SDK.
`packages/plugin-sdk/package.json` already declares `"@gl3/shared": "*"`, and
`packages/plugin-sdk/src/ctx.ts:1` already imports `GameEvent` from it to type
`PluginEventInput["audience"]`. The SDK simply never re-exported the core event
vocabulary. Nothing structural stood in the way.

## Goals

- A ported core module publishes exactly the events its predecessor published,
  in the same order, with the same shapes.
- A ctx capability leaves no post-commit obligation on its caller that the
  caller has no way to discharge.
- No new coexistence path: a ported module's route replaces core's route, and
  the events on the wire are indistinguishable from before the port.

## Non-goals

- Restricting *which* plugins may publish core events. Trust is granted at
  install time (see Trust model).
- Changing `GameEventSchema`. The nineteen core variants and the `plugin.event`
  envelope stay exactly as they are.
- Porting any module. This design unblocks the ports; each port is its own task.

## 1. `tx.events.publishCore` (A)

The SDK gains one exported type and `PluginTx.events` gains one method.

```ts
// packages/plugin-sdk/src/ctx.ts
type OmitFromUnion<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Every core event variant minus the two fields core fills in: `id` (uuidv7)
 * and `at` (ISO string). `plugin.event` is excluded — that envelope has its
 * own input type, `PluginEventInput`.
 */
export type CoreEventInput = OmitFromUnion<
  Exclude<GameEvent, { type: "plugin.event" }>,
  "id" | "at"
>;

readonly events: {
  publish(event: PluginEventInput): Promise<void>;
  publishCore(event: CoreEventInput): Promise<void>;
};
```

Both methods append to **one** buffer, so relative call order is preserved
across the two kinds — which matters, because the crimes port publishes
`crime.resolved` before `player.jailed` deliberately (see §2).

```ts
type BufferedEvent =
  | { kind: "plugin"; event: PluginEventInput }
  | { kind: "core"; event: CoreEventInput };
```

At flush, a core entry becomes `{ id: uuidv7(), at: new Date().toISOString(),
...event }` — the same construction `toEnvelope` already uses, and the same one
core's own emitters use. Validation is free: `publishEvent`
(`apps/server/src/bus/publish.ts`) already runs `GameEventSchema.parse` on
everything it publishes, so a malformed core event throws at the publish site
rather than reaching a client that cannot parse it.

Buffering is what makes CLAUDE.md rule 5 structural here: the buffer lives in
the `transaction()` call's closure and is only drained after `db.transaction`
resolves. A throw discards it with the closure. `publishCore` inherits that
property unchanged.

**Accepted cost:** adding a twentieth core variant becomes an SDK surface
change, because `CoreEventInput` is derived from `GameEvent`. It is derived, not
restated, so it cannot drift silently — but the SDK's version does move. A
contract test makes the coupling visible (§4).

## 2. Capabilities own their side effects — the unordered ones only (B)

The tempting general rule is "a ctx capability publishes the event it implies."
`game/crimes/worker.ts:160-230` shows why that rule is wrong. It encodes three
deliberate decisions in comments:

- `crime.resolved` **is** republished on the already-processed retry path,
  because the retry usually exists precisely because the first attempt committed
  and then died before publishing.
- `player.jailed` and `player.rankedUp` are **not** republished on that path.
- `crime.resolved` is published **first**, "so a client that reacts to
  `player.jailed` can already cross-reference the crime that caused it."

If `jail.sendToJail` auto-published `player.jailed`, a ported crimes module
would lose all three: the event would fire from inside the capability, before
`crime.resolved`, and on every replay. So B splits by whether the caller has a
legitimate reason to control timing:

| Capability | Gains | Rationale |
|---|---|---|
| `economy.applyBalanceChange` | buffered `recordScore` for the changed kind | **B1.** Fixes M6. Derived state, no event, no ordering question. |
| `economy.addExp`, `economy.applyExpAndRankUp` | buffered `recordScore` for `exp` (and `cash`, for `applyExpAndRankUp`) | **B1.** `applyExpAndRankUp` pays a rank-up cash reward through core's own internal `applyBalanceChange`, which the ctx wrapper never sees — so it must buffer both. No `player.rankedUp` event: the crime worker withholds it on replay. |
| `notify` | `notification.created` | **B2.** Fixes M7. Every core caller already pairs the two; none has a reason to separate them. |
| `economy.applyGangBalanceChange` | nothing | No gang leaderboard exists — `LeaderboardKind` is `cash`/`bank`/`exp`, all per player. |
| `jail.sendToJail` | nothing | **B3, rejected.** Ordering and replay semantics belong to the caller, who now has `publishCore`. |

### B1 mechanics

`applyBalanceChange` returns the new balance, so no re-read is needed: the
wrapper buffers `{ kind, playerId, score }` into a `Map` keyed
`` `${kind}:${playerId}` ``, last write wins — which is correct, because the
leaderboard wants the final balance, not each intermediate one. `addExp` returns
`void`, so its wrapper selects the fresh `player_stats.exp` inside the
transaction (a consistent snapshot) and buffers that.

The `points` kind has no leaderboard and buffers nothing.

Flush order after commit: leaderboard writes first, then events — matching
`game/crimes/worker.ts`, which calls `recordScore` before `publishEvent`.

**Failure after commit is not caught.** The crime worker states the reasoning:
the balance already committed is correct, and the next boot's
`rebuildLeaderboards` repairs the index, so failing loudly beats a silent stale
index. The existing event flush already behaves this way — a `publishEvent`
throw after commit surfaces as a 500 on a committed action — so this adds no new
failure mode, only more statements inside one.

### B2 mechanics

`tx.notify(playerId, body)` already generates the notification id
(`ctx.ts:81`). It gains: a select of the target's `players.username` inside the
transaction, and a buffered `notification.created` with `actorId` and
`audience: { kind: "player", playerId }` both set to the **notified** player —
the convention `packages/shared/src/events.ts:51` documents and
`game/gangs/routes.ts:409-421` spells out at length. Getting the actor wrong
would silently break every `awaitOwnEvent` filter (CLAUDE.md rule 4).

A plugin that wants a notification *without* the event has no escape hatch. That
is intentional: no core caller wants one, and adding the option now would be
YAGNI.

## 3. Wiring `leaderboardPrefix`

`PluginCtxDeps` is `{ db, redis, queues, settings }`
(`apps/server/src/plugins/ctx.ts:25`). `recordScore` takes a prefix defaulting to
`DEFAULT_LEADERBOARD_PREFIX`, and `bootTestServer` gives each booted server a
run-unique prefix (`leaderboard-test-${randomUUID()}`) so concurrent test files
do not collide on shared Redis. Without threading, every plugin-driven
leaderboard write during tests would land on the production `leaderboard:*` keys
while the same test's core writes went to its private namespace — a wrong
assertion at best, cross-file contamination at worst.

`leaderboardPrefix: string` therefore joins `PluginCtxDeps`, threaded from
`buildApp` (which already accepts it as `AppDeps.leaderboardPrefix`). Required,
not optional: an omitted prefix silently means "production keys," which is
exactly the bug. `buildApp` applies its own `?? DEFAULT_LEADERBOARD_PREFIX`
default at the one place that already owns that decision.

`LoadPluginsDeps = Omit<PluginCtxDeps, "queues">` (`plugins/loader.ts:22`) picks
the new field up with no second edit — the reason that type was derived rather
than restated.

## 4. Testing

Integration tests against real Postgres and Redis, as everywhere else. No mocks
on DB, queue or bus paths.

- **Drift guard.** `CoreEventInput` must stay in step with `GameEventSchema`. A
  contract test — the pattern `packages/plugin-sdk/test/view-schema-contract.test.ts`
  already establishes — asserts every core variant round-trips through `publishCore`
  and reaches the bus with its type intact. A twentieth variant that forgets the
  SDK fails here.
- **Ordering.** A plugin route that calls `publishCore` then `publish` (or the
  reverse) produces the two events on `game:events` in call order.
- **Rule 5, both kinds.** A transaction that throws after `publishCore`
  publishes nothing.
- **B1.** A committed `applyBalanceChange` moves the leaderboard for its kind
  under the *test's* prefix; a rolled-back one leaves it untouched. Two changes
  to one player in one transaction produce one write, carrying the final
  balance.
- **B2.** `tx.notify` produces both the row and a `notification.created`
  addressed to the notified player.

Every test asserting on `game:events` filters by its own `actorId` via
`awaitOwnEvent` (CLAUDE.md rule 4).

## 5. Trust model

Unrestricted: any loaded plugin may call `publishCore`. Trust is granted when a
plugin is installed, not per call. This is consistent with the surface a plugin
already has — `tx.economy.applyBalanceChange` moves real money, and
`applyGangBalanceChange` moves a gang's — but it is worth stating plainly rather
than leaving to be discovered:

- A plugin can publish `bank.transacted` with numbers that match no ledger row.
- A plugin can address any core event to `audience: { kind: "global" }` and
  reach every connected socket.

The envelope's `plugin.event` type made a plugin's output *identifiable* on the
wire; `publishCore` removes that. A malicious or buggy plugin was already able
to corrupt state before this change — this makes it able to lie about state
too. The mitigation is install-time review, and the operator should know that is
what they are relying on.

## 6. Sequencing

Not one plan. `news` is the smallest port that exercises `publishCore`
end to end — one event (`news.posted`), a global audience, no ctx capability,
no ordering subtlety. It validates the design before `crimes` and `gangs`, which
carry the ordering and lock-order complexity.

Order: this design's SDK + ctx changes → `news` → the remaining six ports, each
its own task, `crimes` and `gangs` last.
