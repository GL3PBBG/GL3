# Detectives — cross-location hunting layer

Date: 2026-08-12. Status: approved in brainstorm, awaiting spec review.

## 0. What this is, and the "best of both worlds" decision

V2 gated *every* kill behind a detective report: paid search, wait window,
report-as-consumable targeting token, permanent death. GL3 shipped combat
without any of that: free same-location target list, one shot per request,
hospital instead of death.

The reconciliation, decided in brainstorm:

- **Same-location combat stays exactly as shipped.** Free target list,
  walk-up fights, no report needed. The `combat` plugin is untouched.
- **Detectives become the cross-location hunting layer**: the only way to
  find a *specific* player who is somewhere else. The report reveals where
  they are so you can travel to them; the attack itself then happens under
  normal combat rules. Scarcity applies to hunts, not brawls.
- Pairs with bounties: see an open contract, hire detectives, travel, kill,
  sweep the bounty. Detectives is the missing first verb of that chain.

Decisions taken with V2 as the reference:

| Question | Decision | V2 comparison |
|---|---|---|
| Report value | **Live tracking**: successful report shows target's *current* location until expiry | Same — V2 joined the live `US_location` on every page load |
| Cost model | **V2's gamble**: cost = `detectiveCost × dets × hours`, success chance = `dets × 4 × hours`% , money sunk on failure | Same knobs (1–5 × 1–5), same formula |
| Roll timing | **In the worker, seeded** (repo rule: outcomes resolve in workers so retries can't re-roll) | V2 rolled at hire time; player-visible outcome is identical because the result is hidden until `ends_at` either way |
| Target awareness | **Silent.** No notification at hire or on success | Same — counterplay is banking cash, moving, out-waiting the window |
| Consumption | **Time expiry only.** Attacking does not consume the report | Deviation — V2 expired the report on first shot, but there the report *was* the attack token; here it is pure intel, and consuming it would re-couple detectives→combat for no gameplay gain |
| Death | Unchanged — kill sends to hospital, never `U_status = 0` permadeath | Deliberate GL3-wide deviation, decided in the combat design |

## 1. Architecture

**`packages/plugins/detectives`** — new plugin, same shape as `bounties`:

- Uses the existing core `detective_searches` table (migration 0000:
  `id, player_id, target_player_id, detectives, started_at, ends_at,
  succeeded bool nullable`). No new table, no plugin migrations.
  `succeeded IS NULL` = roll not yet recorded.
- Schema mirrors: `detective_searches`, `players`, `player_stats`,
  `locations` (for the live-location join).
- **One BullMQ job** (`resolve`) — the second real user of the plugin job
  system after `crimes`. Exactly one job, so the known
  `plugin_job_runs (plugin_id, job_id)` PK gap (STATUS watch item) stays
  latent.
- Settings, V2 key names, read at boot (known limitation, restart to
  retune): `detectiveCost` (default 125000), `detectiveDuration` (seconds
  per hour-unit — **deviation: default 3600**, V2's shipped default of `1`
  second is treated as a bug, not behaviour to preserve), `detectiveExpire`
  (600).
- Eight registration sites per CLAUDE.md;
  `grep -c "packages/plugins/detectives" Dockerfile.server` must be 5.
- **No combat coupling.** No filter point, no ctx addition, no edit to
  `packages/plugins/combat`.

## 2. Data flow

**Hire — `POST /api/detectives`.** Body zod: target username, `detectives`
1–5, `hours` 1–5. Rejects self-search and unknown target. Cost =
`detectiveCost × detectives × hours`. One `ctx.transaction`:

1. `tx.economy.applyBalanceChange` debit, reason `detectives.hire` (locks
   the hirer's `player_stats` row; core `InsufficientFundsError` is
   translated to the SDK's by `plugins/ctx.ts` → 409).
2. INSERT the search row: `ends_at = now + detectiveDuration × hours`,
   `succeeded = NULL`.
3. `ctx.jobs.enqueue("resolve", …)` with the pre-generated seed —
   enqueued immediately, **not** delayed.

**Roll — the `resolve` worker**, which runs right away: one
`ctx.transaction` → `plugin_job_runs` idempotency claim first, seeded
`ctx.job.rng`, success iff roll ≤ `detectives × 4 × hours` (percent),
UPDATE `succeeded`. A BullMQ retry hits the idempotency row and cannot
re-roll.

The **time-gated reveal replaces a delayed job**: the row's outcome exists
in the DB minutes early, but no read path exposes `succeeded` before
`ends_at`. This avoids adding delayed-job support to the SDK, and the
player experience is identical to V2 — which rolled at hire time and hid
the result the same way. No completion notification (V2 had none either;
the hirer checks the page).

**Track — `GET /api/detectives`.** The hirer's searches, newest first.
Per row:

- `now < ends_at` → pending; `succeeded` is **not** revealed.
- `now ≥ ends_at` → reveals `succeeded`.
- Successful and unexpired (`now < ends_at + detectiveExpire`) → joins the
  target's **current** `player_stats.location_id` → location name. The
  target travelling shows up on the next read. Live tracking is just an
  un-cached join — no state to maintain.
- Silent to the target in all cases.

**Remove — `DELETE /api/detectives/:id`** (V2's `method_remove`): own rows
only; 404 (not 403) on someone else's row so existence isn't leaked.

**Locks.** `applyBalanceChange` locks only the hirer's own stats row; the
INSERT's FKs take KEY SHARE on `players` rows — the same non-contending
shape the bounties port proved out. No new lock edges. Recorded here so
nobody adds a lock-order test expecting parity with bullets/travel/combat.

## 3. Web page

`/detectives` — ordinary first-party React in `apps/web/src/pages/`,
routed in `App.tsx`, linked from the Shell nav (same pattern as
`/bounties`):

- Hire form: target username, detectives 1–5, hours 1–5, live cost
  preview (decimal-string money, never a JSON number).
- Searches list, one visual state per row: pending (countdown to
  `ends_at`), failed, succeeded-expired, succeeded-active. Active rows show
  the target's current location and a "Travel there" link to `/travel`.
- Polling via TanStack Query `refetchInterval` while any active row
  exists. No WS event: silence-to-target rules out broadcast, a
  hirer-only audience would work but polling is simpler and the list is
  small.
- Remove button on finished rows.

## 4. Error handling

- **400**: zod bounds (dets/hours outside 1–5, missing target),
  `cannot_search_self`, `target_not_found`.
- **409**: `insufficient_funds` (SDK error; matches the
  bank/travel/bullets convention, not gangs' 400).
- **404**: remove on a nonexistent or foreign row — `not_found`, no
  existence leak.
- **Jail**: hire is allowed from jail — V2 gated only on login;
  `accessInJail: true`.

## 5. Testing

- `apps/server/test/detectives.test.ts` — hire (cost math, ledger row,
  409 on overdraft), reveal gating (pending hides `succeeded`,
  post-`ends_at` reveals it, post-expiry hides the location), the
  live-location join (target travels; the list shows the new location),
  remove ownership (404 on foreign row).
- `apps/server/test/detectives-worker.test.ts` — seeded roll determinism,
  `plugin_job_runs` idempotency (a retried job neither re-rolls nor
  double-writes), formula boundaries: 1×4×1 = 4% and 5×4×5 = 100% — the
  100% case must *always* succeed.
- `economy-invariant.test.ts` gains a `detectiveHire` op — a pure money
  sink to the house, same class as the travel fare.
- **No lock-order test, deliberately** — single-player money path, no
  second FOR UPDATE row; same reasoning as the crimes port, recorded so
  nobody adds one.
- Time control: short durations or a direct `ends_at` UPDATE in test
  setup — no clock mocking; these are integration tests against real
  Postgres.
- New test files go into `vitest.workspace.ts`'s explicit `include`
  lists, and the new package needs a `srcAliases` entry. Both failure
  modes are silent (STATUS, Plan 3).

## 6. Out of scope

- Combat consuming or reading reports (decided against, §0).
- Delayed-job SDK support (made unnecessary by the time-gated reveal, §2).
- Target-side warnings, on by default or setting-gated (decided against;
  a `detectiveWarn` setting can be added later without schema change).
- Hide/stealth mechanics.
- Live settings reload (system-wide limitation, already recorded in
  STATUS).
