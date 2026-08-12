# Organized Crime (heists) — design

Date: 2026-08-12. Status: approved.

## 0. What and why

A new GL3-native gameplay plugin: multi-player heists. A leader assembles a
fixed-role crew by invitation, every member pays a buy-in into escrow, and when
the crew is full and co-located the leader fires the heist. A seeded BullMQ job
rolls one shared outcome: success splits the multiplied pot equally; failure
loses the escrow and jails the whole crew.

Like PvP combat, this is **not a port** — GL2 V2 has organized-crime modules,
but GL3 carries no OC tables and SPEC.md is silent, so the schema and wire
contract are decided here and **the tests are the whole specification**.

Why this system: it is the first *multi-player* economy transaction (N-way
escrow and split), the first multi-player BullMQ job, and it composes with the
cross-location layer just shipped — a crew mid-setup is findable by detectives
and shootable under bounties, because execution requires physical co-location.

## 1. Plugin and package

`packages/plugins/oc`, plugin id `oc`. All eight registration sites apply
(CLAUDE.md conventions), including the five `Dockerfile.server` COPY lines —
`grep -c "packages/plugins/oc" Dockerfile.server` must print 5.

A `/oc` web page ships alongside: first-party React in `apps/web/src/pages/`,
routed in `App.tsx`, linked from the Shell nav (item-economy precedent).

## 2. Data model — plugin-owned, no foreign keys

Two tables, owned and migrated by the plugin (`oc:0001_heists`), following
`p_inventory_shop_stock`: **no foreign keys**, because an FK is a lock
(CLAUDE.md rule 6) and OC must not add lock edges against `players`,
`player_stats`, or `locations`.

**`p_oc_heists`**

| column | type | notes |
|---|---|---|
| `id` | uuid PK | uuidv7 |
| `leader_id` | uuid | no FK |
| `location_id` | uuid | anchor: leader's location at creation; no FK |
| `status` | text | `open \| executing \| done \| failed \| cancelled` |
| `buy_in` | bigint | per-member escrow amount, chosen by leader at creation |
| `created_at` | timestamptz | |
| `executed_at` | timestamptz nullable | set by the worker |

**`p_oc_members`**

| column | type | notes |
|---|---|---|
| `heist_id` | uuid | no FK |
| `player_id` | uuid | no FK |
| `role` | text | one of the fixed role list |
| `state` | text | `invited \| accepted` |
| `released` | boolean default false | true once the heist reaches a terminal status |
| PK | `(heist_id, player_id)` | |

**One active heist per player is a DB constraint, not a check:** partial unique
index `ON p_oc_members (player_id) WHERE NOT released AND state = 'accepted'`.
A racing second accept hits the index and 409s — no check-then-act. Invited
(not yet accepted) rows are exempt: multiple pending invites are fine, the
constraint binds on acceptance. The leader's own mastermind row is `accepted`
from creation, so a leader also cannot start a second heist.

`released` is flipped for all member rows in the same transaction that moves
the heist to a terminal status.

**Roles** are a fixed constant list in the plugin: `mastermind` (the leader,
auto-filled), `driver`, `gunman`, `hacker`. Four slots total. Not data-driven
in v1 — YAGNI; a role catalog table can come later without breaking the wire.

**Settings** (read via `ctx.settings.get`, loaded at boot — restart to change,
same as `combat.*`):

| key | default | meaning |
|---|---|---|
| `oc.buy_in_min` | 1000 | minimum per-member buy-in |
| `oc.success_chance` | 0.35 | single shared roll threshold |
| `oc.payout_multiplier` | 3 | pot × this on success |
| `oc.jail_seconds` | 600 | sentence per member on failure |
| `oc.cooldown_seconds` | 1800 | per-member cooldown after any execute |

## 3. Routes

All authed, jail-gated (default `accessInJail: false`), zod-validated params
and bodies, money as `MoneySchema` decimal strings on the wire.

- **`POST /api/oc`** `{buyIn}` — create. Player must not be in an active
  heist (the partial index enforces it). Heist is anchored to the player's
  current `location_id`. Leader takes the `mastermind` slot as `accepted` and
  pays the buy-in immediately: `applyBalanceChange` debit, ledger kind
  `oc.buyin` (escrow-at-placement, bounties precedent). 409
  `insufficient_funds` via the SDK error; 409 `already_in_heist` on the index.
- **`POST /api/oc/:heistId/invite`** `{playerId, role}` — leader only, heist
  `open`, role unfilled, target not already invited/accepted here. Inserts an
  `invited` row and notifies via `tx.notify`. Cross-location invites are
  allowed — only execution requires co-location.
- **`POST /api/oc/:heistId/accept`** — invitee only. Pays the buy-in
  (debit, `oc.buyin`), flips state to `accepted`. The partial unique index is
  the one-active-heist guard; accepting clears the player's other pending
  invites (gang-invite precedent).
- **`POST /api/oc/:heistId/decline`** — invitee only; deletes the invited row.
- **`POST /api/oc/:heistId/leave`** — accepted non-leader member, heist still
  `open`. Refunds the buy-in (credit, `oc.refund`), deletes the row.
- **`POST /api/oc/:heistId/cancel`** — leader only, heist `open`. Refunds
  every accepted member (including the leader), sets `cancelled`, releases all
  rows. One transaction.
- **`POST /api/oc/:heistId/execute`** — leader only, all four slots
  `accepted`. Under the lock (§5): every member's `player_stats.location_id`
  must equal the heist's `location_id` (409 `crew_not_assembled` naming the
  absent members), no member jailed or hospitalised. Sets `executing`,
  enqueues the seeded job via `ctx.jobs.enqueue`. Advisory pre-checks may run
  before the lock; the authoritative checks are under it (gangs
  pre-check/recheck pattern).
- **`GET /api/oc`** — the caller's active heist (any status short of
  released), with slots, member states, and buy-in; or their pending invites;
  or empty.

Route-level races (two accepts for one role, execute racing leave) are settled
by the lock order in §5 plus the partial index; each has a demonstrated-red
test (§7).

## 4. Worker — one transaction, shared fate

`manifest.jobs: { execute }`, seeded RNG, retries inherited from the loader's
`defaultJobOptions`. **Exactly one `ctx.transaction`** (a second one
self-collides on `plugin_job_runs` — crimes port finding), containing in
order:

1. `plugin_job_runs` idempotency claim (first statement, implicit in
   `ctx.transaction`).
2. Lock the heist row `FOR UPDATE`; verify status `executing` (else no-op —
   the job is stale).
3. `tx.locks.player([...allMemberIds])` — combat's `lockPlayersForUpdate`,
   deduped, ascending.
4. One roll against `oc.success_chance`.
   - **Success:** pot = buy_in × 4; payout = pot × `oc.payout_multiplier`,
     split equally, remainder to the leader (bigint division truncates —
     stated, tested). One `applyBalanceChange` credit per member, ledger kind
     `oc.payout`. Status `done`.
   - **Failure:** escrow is gone (already debited — no movement). Every member
     is jailed via `tx.jail.sendToJail` for `oc.jail_seconds`. Status
     `failed`.
5. Release all member rows; set `executed_at`.
6. Buffer events (`publishCore` notifications / `plugin.event` per member for
   web invalidation), flushed by the loader post-commit (rule 5).

After the transaction commits, the worker sets the per-member Redis cooldown:
`SET oc:cd:<playerId> 1 NX EX <oc.cooldown_seconds>` (rule 2 — no
check-then-act). Cooldown is checked at `POST /api/oc` and `accept`, not at
execute — it gates *joining the next* heist. A crash between commit and the
cooldown SETs loses at most some cooldowns; accepted (same class as the
bounties sweep's crash window — money is never wrong, only a convenience
guard is).

Ledger invariant: every buy-in, refund, and payout is an `applyBalanceChange`
row; `sum(ledger) == balance` holds for every member (§7).

## 5. Lock order — a new root, no cross edges

**Heist row first, then players.** Every mutating path that touches both takes
`p_oc_heists FOR UPDATE` before `tx.locks.player([...])` (ascending). Routes
that touch members without the heist decision surface (decline) may skip the
heist lock; anything that reads slot state to decide (accept, leave, execute,
cancel) locks the heist row first.

Why this is safe against the three existing orders: `p_oc_heists` and
`p_oc_members` carry **no FKs**, so no OC insert takes an implicit
`FOR KEY SHARE` on core rows, and no core path touches OC tables. Combat locks
players only; OC locks heist→players; the shared suffix (players, ascending
via the same helper) cannot invert. Gang↔player and location↔player never meet
an OC lock in one transaction — OC reads `location_id` under the *player* lock
and never locks a `locations` row (the `combat_log` reasoning: the location
matters as data, not as a lock).

## 6. Web page

`/oc`: create form (buy-in), invite form (username + role), slot grid with
member states, execute/cancel/leave/decline buttons per viewer role, outcome
banner from the resolved heist. Invalidation on the plugin's events
(bounties-page precedent). Money rendered from decimal strings.

## 7. Testing

Real Postgres + Redis, no mocks. New files registered in
`vitest.workspace.ts` include lists **and** `@gl3/plugin-oc` added to
`srcAliases` (both failure modes are silent). Event assertions filter by own
`actorId` (rule 4).

- `oc.test.ts` — route contract: create/invite/accept/decline/leave/cancel/
  execute happy paths and every 4xx; escrow and refund ledger rows; 409 leaves
  no ledger row (detectives precedent).
- `oc-worker.test.ts` — success split (incl. remainder-to-leader), failure
  jails all four, replay via `plugin_job_runs` applies nothing twice
  (demonstrated red by disabling the guard).
- `oc-concurrency.test.ts` — two players race one slot: exactly one 200, one
  409, one `accepted` row. Execute-vs-leave race: never both a payout and a
  refund for the same member. Both demonstrated red first.
- `oc-lock-order.test.ts` — heist-first order forced via a barrier
  (combat-lock-order construction), shown producing `40P01` under the
  inverted order.
- `oc-ledger.test.ts` — post-resolve `sum(ledger) == balance` for all four
  members, both outcomes. Dedicated file, hospital-style: the async worker
  cannot ride `economy-invariant.test.ts`'s synchronous `callPluginRoute`
  sweep, and the file says so.

Every regression test demonstrated failing before acceptance.

## 8. Explicitly out of scope (v1)

- Item/role requirements (couples OC to inventory across the plugin boundary —
  the `effects.ts` duplication problem again). Revisit after the
  equipment/inventory split.
- Data-driven role catalogs, variable crew sizes, partial per-role outcomes.
- Timed auto-execute (delayed jobs) — leader-fired only.
- Gang-scoped heists or gang payouts.
- A heist history/log page beyond the resolved-outcome banner.
