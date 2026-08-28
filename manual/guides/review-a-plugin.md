# Review a plugin

> **Audience:** the maintainer who approves a plugin for the marketplace
> registry (`npm.gl3.dev`). Nothing in the repo statically enforces economy
> discipline on plugin code — this review is the gate.

A plugin runs inside the server process with full database access. The
twenty-seven first-party plugins hold five invariants that the whole economy
rests on; a
submitted plugin must hold them too. Every check below is something a real
defect class made necessary.

## Check 1: money moves only through the ledger

Every credit and debit must go through `tx.economy.applyBalanceChange` (or
`applyGangBalanceChange` for gang balances). These take `FOR UPDATE` on the
balance row *inside* the caller's transaction, re-read after the lock, refuse
a negative result, and write the ledger row atomically — which is what makes
a concurrent double-spend impossible and keeps `sum(ledger) == balance` true.

Reject on any direct write to a balance column:

```sh
grep -rn "cash\|bank\|points" packages/plugins/<id>/src \
  | grep -v "applyBalanceChange\|applyGangBalanceChange"   # then eyeball every hit
```

Anything that updates `player_stats.cash/bank/points` or `gangs.cash/bank`
by hand breaks both the double-spend lock and the ledger invariant, silently.

## Check 2: multi-player money paths pre-lock the pair, sorted

Any path that touches two players' money (transfers, bail, kill payouts) must
lock **both** rows in one sorted call **before reading either**, as the
transaction's first statement:

```ts
await tx.locks.player([fromId, toId]);   // sorts internally; one call, up front
```

Per-leg locking (letting each `applyBalanceChange` take its own single-row
lock) is the ABBA deadlock shape: A→B and B→A in flight together each hold
one row and want the other. Postgres kills one with `40P01` — availability
loss, and it means the author hasn't read the lock-order rules.

The cross-table variants have their own helpers with the order built in:
`tx.locks.gangAndPlayer` (gang↔player), `tx.locks.location` /
`tx.locks.locations` (any location row — **always before** the player row),
and the OC heist rule (heist row first). A plugin inventing its own order for these pairs is a
reject even if you cannot immediately construct the deadlock.

## Check 3: cooldown-gated actions claim atomically

A gated action must claim its gate with the Redis `SET … NX` helper
(`ctx.cooldown.acquire`) — one atomic claim, winner-takes-all — and call
`ctx.cooldown.release` on any failure path taken *after* a successful claim,
or the failed attempt locks the player out for the full TTL. Check-then-set
(`ctx.cooldown.peek` then a set) is a time-of-check race: two parallel
requests both see the gate open.

## Check 4: shared non-player rows get their own lock

A resource multiple players contend over that is not a player row — bullet
stock is the canonical example — must be `FOR UPDATE`-locked before any
buyer's row is touched (see Check 2's locations-first rule). Otherwise
parallel purchases oversell it; the first-party suite pins this with a
stock-of-1 concurrency test. If the plugin adds such a resource, it needs
the same lock and the same style of test.

## Check 5: transfer pairs post both legs under one reason

A player-to-player transfer must post the debit and the credit under a single
`reason` string (e.g. both legs of a kill payout are `combat.kill_payout`).
The economy dashboard's net-by-reason is the faucet/sink instrument; split
reasons render one transfer as a giant faucet *and* a giant sink of the same
size.

## Dynamic-loading pitfalls

A plugin installed through `PLUGIN_PACKAGES` brings its own copy of
`@gl3/plugin-sdk`, so SDK error classes must never cross the boundary as
`instanceof` checks — require the `isPluginError` siblings instead (same rule
as [Create a plugin](./create-a-plugin.md)).

## Runtime tells after shipping

If something slipped through, it shows up as:

- **`40P01 deadlock_detected`** in server logs — a lock-order bug (Check 2).
- **Economy dashboard reasons whose net is not ~0** for a known transfer —
  split legs (Check 5).
- **A negative balance or `sum(ledger) != balance`** — a bypassed ledger
  (Check 1).
