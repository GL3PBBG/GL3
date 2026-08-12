# Bounties — design

**Date:** 2026-08-12
**Scope:** the `bounties` plugin and a small addition to the `combat` plugin (one filter point).
**Status:** design approved, not yet planned.

---

## 1. Why this, and why now

PvP combat and the item economy have shipped. The contracts cluster (V2's
`bounties` module) is the natural next step: it is the smallest cluster that
builds directly on kills, and it makes killing a *directed* activity — the
open-bounty list is a reason to shoot a specific player rather than whoever
happens to share a city.

It is also the first live user of the SDK's **filter system**. The loader
wiring (`manifest.provides` / `manifest.filters`, `ctx.filters.apply` →
`runFilterChain`) has existed since the SDK foundation but no shipped plugin
declares a point or subscribes to one; only SDK unit tests exercise it. V2's
`userKilled` hook — the exact shape this design uses — is one of the two hook
patterns SPEC §5 requires the plugin API to cover. Shipping bounties proves it
cross-plugin.

### Fidelity stance

V2's bounties module is thin: place a bounty (`B_user`, `B_userToKill`,
`B_cost`), and the kill module's `userKilled` hook pays it. GL3 keeps that
shape and the core `bounties` table (already in migration `0000`, already in
M4's migration order), and makes the payout rules explicit where V2 left them
implicit.

---

## 2. Decisions (made with the user, 2026-08-12)

1. **Escrow at placement.** The placer pays when the bounty is placed; the
   money is represented by the open row itself. No separate escrow account.
2. **Stacking, killer takes all.** Any number of players may place bounties on
   the same target (including several from one placer). A kill sweeps every
   open bounty on the victim to the killer in one transaction.
3. **Public placer.** The open-bounty list shows target, amount and placer
   name. `bounty.placed` already carries `actorName`; nothing to hide.
4. **Placement rules:** minimum amount (setting `bounties.minAmount`, default
   `1000`); no self-bounty; no gang-mate bounty (checked at placement only);
   **no cancel** — escrowed money is committed until claimed or the target row
   is deleted.

---

## 3. Architecture

### Table — core `bounties`, as-is

`apps/server/src/db/schema/social.ts:54`. No new columns, no plugin
migrations. `claimed_by IS NULL` = open. There is no `claimed_at`; the ledger
row's timestamp serves for audit.

Consequence of the existing FKs, accepted for v1: `target` is
`onDelete: cascade`, so deleting a player deletes open bounties on them and
**burns the escrow** (the placer was debited at placement; no refund path).
`claimed_by` is `onDelete: set null`, so a claimed row survives its killer.
Admin refund tooling is future work, out of scope.

### Lock order (CLAUDE.md rule 6)

Placement inserts a row whose FKs reference **both** the placer and the target
→ `FOR KEY SHARE` on both player rows. Combat locks `{attacker, victim}`
sorted in one statement. A placement that debits the placer first
(`FOR UPDATE` via `applyBalanceChange`) and then inserts would wait on the
target's row while combat, holding the victim, waits on the placer —
a deadlock whenever the placer is mid-fight and the victim's id sorts first.

**Rule:** placement calls `tx.locks.player([placerId, targetId])` as its first
statement — sorted, one statement, same order as combat — then debits, then
inserts.

The claim sweep locks only `[killerId]`. Its `UPDATE … SET claimed_by` takes
`FOR KEY SHARE` on the killer's own row (already held) and touches no other
player row: `placed_by`/`target` FKs are checked on INSERT, not on this
UPDATE.

### Payout: `combat.killResolved` filter point

- The **combat** plugin exports
  `killResolved = filterPoint<KillResolved>("combat.killResolved")` with
  payload `{ killerId, victimId }`, and lists it in `manifest.provides`.
- Combat's attack route applies it **after** `ctx.transaction` resolves, only
  on a kill: `await ctx.filters.apply(killResolved, { killerId, victimId })`.
  Filters run outside transactions (SDK rule); this is the notification use of
  the filter chain — the value passes through unchanged.
- `runFilterChain` propagates a subscriber's throw, so combat wraps the apply
  in try/catch + `ctx.log.error`. Combat's response (already committed, kill
  already earned) must not turn 500 because a subscriber failed.
- The **bounties** plugin subscribes via `manifest.filters:
  [on(killResolved, …)]`. The subscriber runs its own transaction:

  ```
  ctx.transaction:
    locks.player([killerId])
    UPDATE bounties SET claimed_by = $killer
      WHERE target = $victim AND claimed_by IS NULL
      RETURNING id, amount, placed_by
    if rows.length === 0: return            -- no-op, no writes
    applyBalanceChange(killer, +sum(amount), "bounties.claimed")
    for each row: publishCore bounty.claimed
      (audience: killer and that row's placer — two publishes per row)
    notify each distinct placer
  ```

**Why this is crash-safe without a queue:** if the process dies between
combat's commit and the filter run, the bounty rows are still open and the
escrow untouched — the next kill of the same target sweeps them. Money is
never lost, only delayed. The sweep is idempotent by shape
(`WHERE claimed_by IS NULL`); a duplicate filter invocation claims zero rows.
This is why approach C (a durable BullMQ job) buys nothing here.

### Events

Existing core variants via `publishCore`; **no new event types**.

- `bounty.placed` — actor = placer, audience **global** (the public list is
  the feature; it reveals that a target is hunted, not where they are).
- `bounty.claimed` — actor = killer, audience = killer and the row's placer
  (per-row, two publishes each; `AudienceSchema` has no two-player kind).

---

## 4. Routes and DTOs

DTOs in `packages/shared/src/dto/bounties.ts`. Zod on bodies and params;
money as `MoneySchema` decimal strings.

### `POST /api/bounties` — place

Body `{ targetUsername, amount }` — username, not id, following the gang
invite route's precedent (the web has no player-search endpoint; the server
resolves). Handler order:

1. zod: `amount` parses, `> 0n`.
2. `amount >= bounties.minAmount` else `below_minimum` 409.
3. transaction: resolve `targetUsername` → id (plain SELECT, no lock;
   unknown → `target_not_found` 404). `id === player.id` → `self_bounty` 409.
   Then `locks.player([placer, target])` — sorted, one statement — and under
   the lock: gang check (both `gangId`s non-null and equal → `same_gang`
   409), `applyBalanceChange(placer, -amount, "bounties.placed")`
   (`insufficient_funds` 409 surfaces from the ledger), insert row,
   `publishCore bounty.placed`.
4. Returns `{ bountyId, cash }` (new balance, decimal string).

### `GET /api/bounties` — open list

Open rows joined to target and placer usernames, target's rank, newest first.
Grouped client-side; the wire format is flat rows plus a per-target `total`.
No claimed-history route, no pagination in v1 (the list self-prunes on every
claim).

---

## 5. Web

`/bounties` page in `apps/web`: open list (target · rank · amount · placer ·
age) and a place form (target username text input — sent as-is, the server
resolves it — plus amount input). Money rendered with `Money`. Nav entry follows the
plugin page pattern. Jailed/hospitalised viewers may still place bounties —
placing is not a physical act; no gate, matching the server.

---

## 6. Errors and edge cases

| Case | Behaviour |
|---|---|
| Unknown target username | `target_not_found` 404, at in-transaction resolution |
| Self-bounty | `self_bounty` 409 |
| Same gang (both non-null) | `same_gang` 409, placement-time only; later membership changes leave the bounty valid |
| Below `bounties.minAmount` | `below_minimum` 409 |
| Placer can't afford | `insufficient_funds` 409 from `applyBalanceChange` |
| Placer dies before claim | Bounty stays open — escrow already left their cash |
| Target deleted | FK cascade deletes rows; escrow burned (documented above) |
| Two kills race one victim | First kill hospitalises; combat rejects the second. Even raced, the second sweep matches zero rows |
| Filter subscriber throws | Combat catches + logs; attack response unaffected; bounty stays open for the next kill |
| Kill with zero open bounties | Subscriber sweep returns no rows; no writes, no events |
| Duplicate filter invocation | Sweep is claim-once by `WHERE claimed_by IS NULL` |

---

## 7. Testing

Integration against real Postgres/Redis; no mocks. New files added to
`vitest.workspace.ts` include lists (an unlisted file silently never runs).
All `game:events` assertions filter by own `actorId` via `awaitOwnEvent`
(CLAUDE.md rule 4).

- **`bounties.test.ts`** — placement happy path (row, ledger debit, event);
  every 4xx above; `bounties.minAmount` override via settings; stacking:
  three placers, one kill, killer credited the sum, all rows claimed.
- **`bounties-claim.test.ts`** — kill through the real combat route pays the
  bounty; zero-bounty kill is a no-op; a claimed bounty is not re-claimed
  when the same target is discharged and killed again; placer is notified.
- **`bounties-lock-order.test.ts`** — placement racing combat on the same two
  players, participants deliberately *not* sharing lock acquisition by
  construction (rule 6 corollary); assert no `40P01`.
- **Filter failure** — a test-local subscriber that throws: attack still
  200, bounty still open, error logged.
- **Proof of failure** — each acceptance test shown red before green (repo
  working method).

The ledger invariant test (`sum(ledger) == balance`) already covers escrow
accounting globally.

---

## 8. Registration checklist (all eight sites)

`packages/plugins/bounties/`, `apps/server/package.json` + `npm install`,
`apps/server/tsconfig.json` references, root `tsconfig.json` references,
`vitest.workspace.ts` `srcAliases`, `plugins/core-plugins.ts`, no old `app.ts`
registration to delete (new plugin, not a port), and **five
`Dockerfile.server` COPY lines** —
`grep -c "packages/plugins/bounties" Dockerfile.server` must print 5.
`npx tsc --build --force apps/server/tsconfig.json` locally is the CI-image
typecheck.

---

## 9. Out of scope

Cancel/refund routes, admin tooling for orphaned escrow, claimed-bounty
history, pagination, anonymous bounties, gang-level bounties, bounty expiry.
