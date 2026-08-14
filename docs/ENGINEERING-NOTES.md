# Engineering notes

Why parts of this codebase look the way they do. Every item here cost real
debugging time; several were bugs that reached a commit before being caught.

`SPEC.md` says what to build. `CLAUDE.md` is the short version of this file.

---

## Correctness

### BullMQ is at-least-once — a seed is not idempotency

The crime worker commits its transaction, then publishes an event. If the publish
throws, the processor throws, BullMQ retries with `attempts: 3`, and **the whole
handler runs again** — same seed, same roll, and the transaction executes a second
time. A player was paid two or three times for one crime, with duplicate ledger rows.

The plan originally justified retries with *"safe because the seed lives in the
payload"*. That reasoning is **false**: seed-determinism makes the *outcome*
reproducible, and says nothing about re-running side effects that already committed.

**The pattern:** `crime_log.job_id` is a nullable column with a UNIQUE index. The
worker inserts that row **first**, inside the transaction, keyed to `job.id`. A
unique violation means the job already ran, so it skips crediting entirely. Nullable
*and* unique is deliberate — Postgres treats NULLs as distinct, so the index only
ever rejects a second row for the same job.

Everything a worker does that mutates the economy must sit **after** that insert,
inside the same transaction. In `crimes/worker.ts` that is: payout → rank promotion
(which pays cash) → jail sentence.

Two decisions worth preserving:
- **A duplicate-detecting job still republishes its event.** The common case is
  "first attempt committed, then died before publishing" — staying silent would
  leave a client waiting forever. Clients dedupe on `event.id`.
- **A publish failure *does* fail the job.** With the guard in place a retry is
  safe, which converts a silently-dropped event into guaranteed eventual delivery.

### Catch unique violations outside the transaction

Drizzle wraps the driver error in `DrizzleQueryError` with the real `PostgresError`
at **`.cause`**. A guard checking only the top-level error misses it and you get a
500 instead of the intended branch. Catch *outside* `db.transaction(...)` rather
than in the callback, so you don't depend on Postgres' aborted-transaction
semantics. See `uniqueViolation()` in `auth/routes.ts` and `crimes/worker.ts`.

### Never check-then-act on Redis

Two shipped bugs came from this shape:

- The rate limiter did `INCR`, then `EXPIRE` only when `hits === 1`. A crash between
  them left a key with **no TTL** — and since later requests never re-enter that
  branch, that IP was rate-limited on that endpoint *forever*. Fixed with
  `SET key 0 EX <window> NX` then an unconditional `INCR`, so the key and its TTL are
  created atomically.
- The WebSocket handshake ticket must be consumed with **`GETDEL`** (or Lua). A
  `GET` followed by `DEL` would let two simultaneous upgrades redeem the same
  single-use ticket.

### The ledger is the only way money moves

`applyBalanceChange` (`economy/ledger.ts`) writes the ledger row and the balance in
the caller's transaction. Its `Tx` type is derived from Drizzle's transaction
callback, so calling it outside a transaction does not typecheck.

- The overdraft check runs **before** either write, so a rejected debit never
  touches the database rather than relying on rollback.
- Two-sided movements (bank deposit = cash down + bank up) must be in **one**
  transaction; a crash between them creates or destroys money.
- `test/economy-invariant.test.ts` enforces `sum(ledger) == balance` per player, per
  kind, across 1000 seeded operations — with a >50% success-rate guard, because a
  run dominated by rejected operations would look thorough while stressing nothing.

### Lock ordering prevents deadlocks — and it's the SQL, not the JS

`lockPlayersForUpdate` sorts ids in JS *and* has `.orderBy(asc(...))` in the query.
`EXPLAIN` shows the plan is `LockRows → Sort (Sort Key: id)`: **Postgres sorts before
acquiring locks, driven by the SQL `ORDER BY`**, independent of the order values
appear in the `IN` clause. The JS `.sort()` is a redundant guard. Do not drop the
`.orderBy()` believing the sort covers it.

Existing precedent for multi-row work: the bullets shop locks **location before
player**. Keep new orderings consistent with that.

### Shared mutable resources need real locking

`locations.bullet_stock` is global to a location, not per-player, so two concurrent
buyers can oversell it. Fixed with `SELECT … FOR UPDATE` on the location row inside
the same transaction as the decrement and the debit.

A **sequential test cannot catch a lost update.** `bullets.test.ts` fires two
concurrent purchases against a stock of 1 and asserts exactly one succeeds, stock
ends at 0 and never negative, and exactly one ledger row exists.

### Jail lives in Postgres, not Redis

`player_stats.jailed_until` is a typed `timestamptz` specifically so a Redis flush
cannot free prisoners (SPEC §2.2). Redis may cache, but any action-gating check must
consult the database. Jailed players are blocked from crimes and travel with a
`423`, returned *before* any cooldown is claimed or job enqueued, so a blocked
attempt costs the player nothing.

### The sentence sweeper: a tick, not a job queue

Before this, nothing in GL3 freed a player on a timer — `GET /api/jail` called
`releaseIfExpired` and `GET /api/hospital` called `settleHospital`, and
**asking was what ended a sentence.** The client papered over that with a
2-second poll (the hospital one unconditionally, even for a healthy player
sitting on the page — a plain bug). Two designs were weighed for a
server-side fix:

- **One delayed BullMQ job per sentence.** Exact timing, zero idle work.
  Rejected: `sendToJail`/`sendToHospital` are plugin-facing SDK surface
  (`tx.jail.sendToJail`, `tx.hospital.sendToHospital`), so enqueue-after-commit
  would be an SDK change; re-jailing or pardoning leaves an orphan job needing
  jobId dedup; and rows created outside that path (the M4 V2 import) would get
  no job at all.
- **A sweep tick (chosen).** One indexed `SELECT` per pass against a partial
  index that only contains rows with an active sentence (migration `0008`),
  then one small transaction per expired row. The atomic claim is the existing
  `UPDATE ... WHERE ... IS NOT NULL RETURNING` — multi-instance safety and
  CLAUDE.md rule 1 (at-least-once idempotency) come free from the statement,
  no bookkeeping table needed. No SDK change, no orphan-job bookkeeping, and it
  catches rows from any origin including imported ones.

**It settles one player per transaction, deliberately — not one bulk
UPDATE.** CLAUDE.md rule 6: a bulk `UPDATE ... WHERE hospital_until <= now()`
takes row locks in *scan order*, not sorted order, which can invert the
ascending order combat's `lockPlayersForUpdate` imposes on the player↔player
pair and deadlock (`40P01`). Holding exactly one player lock at a time cannot
deadlock against anything — a deadlock needs a cycle, and a single-lock
holder has no outgoing edge. `test/sentence-sweeper-lock-order.test.ts`
proves this the same way the other three lock-order tests do: the bulk-UPDATE
shape was shown failing before the per-player loop replaced it. **Do not
"simplify" this into a bulk UPDATE** — it is faster in isolation and wrong
the moment it runs next to combat.

The lazy path on `GET /api/jail` and `GET /api/hospital` stays and is
unchanged. If the sweeper process dies, a deploy restarts it, or someone runs
the server with `SWEEP_INTERVAL_MS=0`, players must still get out — the tick
is belt-and-braces, never the only mechanism. For the same reason the client
keeps a slow *safety* poll (30s) instead of dropping polling entirely: a
socket mid-reconnect would otherwise leave a client stuck on a stale
"jailed" screen indefinitely.

---

## Security

- **WebSocket auth uses a short-lived (~30s) single-use ticket**, not the session
  token. URLs leak into access logs, proxy logs and `Referer` headers, so a
  long-lived credential must never appear in one. `POST /api/ws/ticket` mints it;
  the gateway consumes it with `GETDEL`. The session token is **not** accepted at
  the upgrade. **A reconnect needs a fresh ticket** — replaying the old one fails
  silently in a way that looks like a dead socket rather than an auth error.
- **Origin is validated** against the CORS allowlist to prevent Cross-Site WebSocket
  Hijacking. Reject a *present but disallowed* Origin; **allow an absent one** —
  browsers always send `Origin` on WS handshakes and non-browser clients never do,
  and the attack vector is a malicious page, which cannot suppress its own Origin.
- **`CORS_ORIGINS` rejects `*`** in the zod schema. Without that an operator could
  silently defeat SPEC §7's strict-CORS requirement.
- **Registration narrows its error handling** to SQLSTATE `23505` and branches on the
  constraint name, so an email conflict isn't reported as `username_taken` and a
  genuine DB outage surfaces as a 500 rather than a 409.
- Legacy V2 passwords are `sha256(U_id . plaintext)` — the **integer** V2 id string-
  concatenated with the plaintext. Get this wrong and every migrated player is
  locked out permanently. Verification lowercases (MySQL dumps contain uppercase
  hex) and length-checks before `timingSafeEqual`, which *throws* on length mismatch
  rather than returning false.

### Authorization: ABAC-lite (role-module grants)

GL3 uses a role-based model with attribute flavour. A `roles` row is just
`(id, name, color)` — it carries no grants of its own. Grants live one table
over, as rows in `role_module_access(role_id, module_key)`: one row per module
key a role can administer (e.g. `"travel"`, `"bullets"`), with the wildcard
`"*"` meaning all modules. `loadGrants` collects the module keys for the
player's active role, and `hasPermission(grants, moduleKey)` in
`@gl3/plugin-sdk` checks whether they include the requesting module or `"*"`.

**Predicate-level checks are deliberately deferred.** The ABAC design in SPEC
describes resource-level predicates (e.g. "admin of travel, but only towns in
location X"). No gameplay path needs that today — every admin section is a
full CRUD surface for its module — and shipping half a predicate system would
mean choosing a shape that a real requirement later forces to change. The
grant check is module-level only; if predicates are added later, the
`hasPermission` call site is the obvious extension point.

**Why `/api/admin` is not wholesale-reserved.** Core reserves the exact paths
`/api/admin/plugins` and `/api/admin/roles` — it does *not* reserve the
whole `/api/admin/` prefix. Each plugin claims `/api/admin/<pluginId>` (e.g.
`/api/admin/travel`). Wholesale reservation would either block future
first-party admin surfaces or require an escape hatch that undermines the
guarantee. The per-plugin claim is enforced by the loader's boot validation.

**The first-registration advisory lock.** The first player to register is
automatically promoted to Administrator with a `"*"` grant. This is guarded by
`pg_advisory_xact_lock(7461001)` inside the registration transaction, which
serialises the probe-and-claim race. Read committed is what makes the race
real: each transaction inserts its own player row first, so each sees exactly
one player — its own — and neither sees the other's uncommitted insert. Both
therefore conclude "I am the first" and both claim admin. Proven at the DB
level (3/50 without the lock produced 2 admins). The probe is written as
"does any player other than me exist?", and it runs *before* the lock so that
every registration after the first skips the lock entirely; when it comes back
empty the same probe is repeated under the lock, and that second answer is the
one that decides. The advisory lock number is arbitrary but fixed; a second
registration call inside the same transaction would deadlock on it (not that
one exists today).

**The `roles` grant is transitively equivalent to full admin.** Anyone who
can assign roles can grant themselves `"*"`, which is full admin. Grant the
`roles` permission only to players who already have `"*"`. Core's role
management routes enforce `cannot_demote_self` and require the `roles` grant
to assign or clear roles, but they do not prevent granting `"*"` to a player
who then grants `roles` to an accomplice. This is by design — the trust
model is that role assignment is itself an admin-only operation, and admins
are trusted. Do not give `roles` to anyone who should not have full admin.

---

## Test infrastructure

The suite grew from 12 to 22 files during M2 and broke twice on the way. Both fixes
removed work rather than widening deadlines.

- **Each test file gets its own database**, cloned from a pre-migrated **template**
  built once per run in `globalSetup`. Per-file migration didn't scale: at 16 files
  the setup phase took ~25s and hooks timed out. Templating brought it to ~2s.
- **`STRATEGY = WAL_LOG` matters as much as templating.** Postgres' default
  `FILE_COPY` serialises concurrent `CREATE DATABASE` — 10.3s for 14 clones versus
  0.28s. The template alone would not have fixed it.
- **`vitest.workspace.ts` splits tests into four projects by actual need**
  (`unit` / `redis-only` / `db-only` / full). `password.test.ts` is a pure unit test
  and was paying for a database clone *and drop* it never used — that was the real
  cause of file-level hook timeouts, not database contention.
- **`hookTimeout` in the root `vitest.config.ts` is a no-op for workspace projects.**
  It must be set per-project. `maxWorkers` / `minWorkers` *are* pool-level and do
  apply from root. Proven empirically after a first fix silently did nothing.
- **`bootTestServer()` mints a private BullMQ queue name per call.** Workers compete
  across processes on shared Redis, so one file's job could be claimed by another
  file's worker bound to a different database, correctly treated as "deleted between
  enqueue and resolve", and silently dropped — leaving the waiting test to hang.
- **Leaderboard keys are namespaced per `bootTestServer()` call.** They are global in
  production (correct: many instances, one game), but every test file rebuilding into
  the same sorted sets made exact top-N assertions racy. A scoped `del` of *global*
  keys is worse than nothing — it destroys another file's entries mid-run.
- **`awaitOwnEvent()` (`test/helpers/events.ts`) filters `game:events` by `actorId`.**
  A bare `once("message")` resolves on whichever file's event lands first. Five files
  had this bug. Negative assertions ("no such event arrived") need the filter most.
- **WebSocket tests must attach `message` listeners synchronously**, before `open`
  resolves, buffering frames into a queue. The gateway sends `ready` immediately
  after the handshake; on loopback both land in one client read, and a listener
  attached one microtask later drops the frame permanently. The fix belongs in the
  test — delaying the server's `ready` frame to suit a test harness was proposed and
  rejected.
- **Two full suites cannot run concurrently** on this box. Overlapping runs cause
  hook timeouts and cross-talk that mimic regressions.

---

## Tooling traps

- **Bigint defaults must be `` .default(sql`0`) ``**, never `.default(0n)`.
  drizzle-kit's serialiser throws `Do not know how to serialize a BigInt` — a known
  open upstream bug in every stable 0.x. `mode: "bigint"` governs the read/write
  mapping, not the DDL default, so the emitted SQL is identical. **Never change a
  column's `mode` to work around tooling** — that reintroduces the signed-32-bit
  ceiling this schema exists to avoid.
- **drizzle-orm must be ≥ 0.45.2** — earlier versions carry high-severity SQL
  injection advisory GHSA-gpj5-g38j-94v9.
- **`npm audit`'s suggested drizzle-kit fix is a downgrade to 0.18.1** that would
  reintroduce that CVE. Do not follow it.
- **A clean Postgres reset must drop both the `public` *and* `drizzle` schemas.**
  Drizzle's bookkeeping table lives in the `drizzle` schema and survives a
  `public`-only drop, after which the migrator silently no-ops and you test nothing.
- **Run `db:migrate` against the dev database after adding a migration.** Test
  databases migrate themselves, so a stale dev database passes the entire suite while
  every background job fails silently in the running app. This happened.
- drizzle-kit auto-names generated migrations; if you rename the file,
  `meta/_journal.json`'s `tag` must match or the migrator won't find it.
- The `@gl3/shared` alias in vitest points at **source**, not `dist`, so a stale
  build cannot produce a false green.

---

## Schema notes

- Circular foreign keys (`players` ↔ `player_stats` ↔ `gangs`) need an explicit
  `AnyPgColumn` return-type annotation on the reference callback, or TypeScript
  infers `any` — which the no-`any` rule forbids anyway.
- UUIDv7 primary keys are generated in the application. Columns are plain `uuid`
  with **no** database default; Postgres 16 has no v7 function.
- `citext` requires `CREATE EXTENSION IF NOT EXISTS citext` as the **first**
  statement of the initial migration, before any citext column is created.
- `schema.test.ts` asserts **exact** counts of tables, foreign keys and indexes.
  When a migration changes them, update the numbers — **do not weaken the assertions
  into ranges**. Catching schema drift is their entire purpose, and they have caught
  it.
