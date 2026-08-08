# GL3 project status

Last updated: 2026-08-08, after M3 completion.
Branch: `feat/m0-m1-scaffold-and-vertical-slice` (79 commits ahead of `main`, at
`c4d2b41`).

---

## Milestones

| Milestone | State | Notes |
|---|---|---|
| **M0 Scaffold** | ✅ complete | Monorepo, CI, docker-compose, all 32 tables migrated |
| **M1 Auth + vertical slice** | ✅ complete | Acceptance criterion proven end to end |
| **M2 Core loop parity** | ✅ complete | `sum(ledger) == balance` gate passing |
| **M3 Social** | ✅ complete | Both SPEC §6 checkmarks proven end to end |
| **M4 Migration CLI** | 📋 planned, blocked | 33 tasks — needs a MariaDB install (below) |
| **M5 Plugin SDK** | ❌ not planned | Now unblocked; refactors M2's bank into a plugin |

**Suite: 33 files / 220 tests**, green. Count verified by the controller's own
`npm run verify` run, not taken from an agent report.

---

## What actually works today

A player can register (argon2id) or log in with a **legacy V2 password**, which is
transparently upgraded to argon2id on first successful login. They receive a session
token, and a separate short-lived single-use ticket for the WebSocket handshake.

They can commit a crime: the request validates, atomically claims a Redis cooldown,
and enqueues a BullMQ job carrying a pre-generated seed. A worker resolves the
outcome in one Postgres transaction — payout through the ledger, exp, possible rank
promotion with its cash reward, possible jail sentence — then publishes a validated
event after commit. The WebSocket gateway fans it out by audience, and the React
client renders it live.

They can also bank cash, travel between locations (paying a fare), and buy bullets
from a location's shared stock. Leaderboards are Redis sorted sets rebuilt from
Postgres on boot. Jailed players are blocked from crimes and travel.

They can found a gang and run it: invite players (the invitee is notified live over
the WebSocket), accept or decline, leave, be kicked, and hold granular permissions
granted by the boss. The gang has its own bank — deposits and withdrawals move money
between a player and the gang, both sides ledgered in one transaction. Every
membership change appends a gang log row.

They can also send threaded mail, read and mark notifications, view any player's
public profile, and read game news.

Every balance movement anywhere is an append-only ledger row inside the same
transaction as the balance update.

**Every path touching a (gang, player) pair takes both rows through
`lockGangAndPlayerForUpdate`**, which orders them by UUID string comparison. That is
the single global lock order, and it is not optional: the membership routes
originally locked `player_stats` first and reached the `gangs` row implicitly (the
`FOR KEY SHARE` Postgres takes when a `gang_logs` or `gang_members` FK is checked),
which inverted the bank routes' order and deadlocked them — `40P01`, surfacing as an
HTTP 500 on a well-formed request. `test/gang-lock-order.test.ts` is the regression
test. `POST /api/gangs` is the one documented exemption, and only because it INSERTs
its own `gangs` row in the same transaction under a fresh uuidv7, so no other
transaction can want a lock on a row it cannot see.

---

## What M3 shipped

All 10 tasks of `docs/superpowers/plans/2026-08-07-gl3-m3-social.md` are complete:
gangs (create / invite / roles / bank / logs), mail, notifications, profile, and
game news.

**Acceptance criterion (SPEC §6) — met.** `test/acceptance/m3-acceptance.test.ts`
proves both halves in one flow: a gang is founded, the invitee is notified live over
the WebSocket, the invite is accepted, and a bank deposit and withdrawal reconcile
`sum(transactions) == gangs.bank` at the property level rather than trusting the
HTTP response body. Both assertions were demonstrated failing against deliberately
broken code before being accepted.

## Starting M4

Read `CLAUDE.md` and `docs/ENGINEERING-NOTES.md` first, then unblock the MariaDB
install below.

Extract a task brief with:

```bash
.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/\
subagent-driven-development/scripts/task-brief \
  docs/superpowers/plans/2026-08-07-gl3-m4-migration-cli.md 1
```

### What M3 established that later work must not undo

- **Lock ordering is per row-pair, not one global rule for the whole app.** There
  are two orders and they do not conflict: gang↔player goes through
  `lockGangAndPlayerForUpdate` (UUID comparison); location↔player is the bullets
  shop's **location before player**. Travel is the mirror of bullets (player first,
  then `FOR KEY SHARE` on `locations` via the `location_id` update) and is inert
  only because it rejects destination == current before touching that row. Adding a
  path that locks a location and a player in a new order, or a gang and a player
  outside the helper, reintroduces SPEC §2.3's deadlock class.
- **An implicit FK lock counts as a lock.** Inserting a row whose FK references a
  locked row takes `FOR KEY SHARE` on it, which conflicts with `FOR UPDATE`. This is
  invisible in the code — no lock call appears — and it is what caused the M3
  deadlock. When reasoning about lock order, read the FKs, not just the lock calls.
- **`gang_permissions` rows are masked, not trusted.** `hasGangPermission` inner-joins
  `gang_members`, so a row for a non-member confers nothing. Three layers keep it
  that way: the grant route refuses a non-member target, accept-invite deletes rows
  that exist anyway, and the join denies whatever survives. Any future code path that
  inserts a `gang_members` row must delete the matching permission rows first.
- **Gangs have two balances** (`gangs.bank` and `gangs.cash`), preserved from V2's
  `G_bank` / `G_money`.
- **The `gang` audience** in the WS gateway resolves members via `gang_members`. The
  gateway routes purely on `event.audience` and knows nothing about features — keep
  game rules out of it.
- Mail is threaded (V2's `M_parent` → `thread_id`).
- **New test files must be added to `vitest.workspace.ts`.** The `include` lists are
  explicit; an unlisted file is silently never run and looks exactly like a green
  suite.

---

## M4 is blocked on one command from you

M4 builds the CLI that converts a live V2 **MySQL** database into GL3 Postgres. To
test a MySQL reader honestly, the tests need a MySQL-compatible server. Docker is
unavailable here, so the plan uses MariaDB as the wire-compatible substitute.

```bash
sudo apt-get install -y mariadb-server mariadb-client && sudo service mariadb start
```

`sudo` needs a password, so this has to be run by a human. Task 1 of
`docs/superpowers/plans/2026-08-07-gl3-m4-migration-cli.md` has the full setup.

**To be clear: GL3 remains Postgres-only.** `apps/server`, `apps/web` and
`packages/shared` have zero MySQL dependencies. `mysql2` appears only in the planned
`apps/migrate` package, and MariaDB only ever hosts a throwaway test fixture. The
data flow is one-way — V2 MySQL → GL3 Postgres — and the migrator is a one-shot
cutover tool.

---

## Known issues and watch items

**Open, deliberately deferred:**

- **The spare databases `gl3_a`..`gl3_d` are NOT migrated past `0002`.** Anything
  touching an M3 table fails there with `42703 column "gang_id" does not exist`.
  They are fine for M0–M2 probes and useless for anything newer. Migrate them before
  relying on one.
- **`GET /api/mail` and `GET /api/notifications` are unbounded and unpaginated.**
  Mail is the larger problem of the two: it returns full message bodies (up to 5000
  chars each), and mail volume will outgrow notification volume. Bound both before
  any real deployment.
- **Only kick × deposit has deadlock-regression coverage.** Leave, accept-invite and
  `PUT /permissions` were fixed in the same commit and are sound by the same
  argument, but no test proves them. If you edit those lock lines, that is the gap.
- **No unique constraint on `gang_invites (gang_id, invited_player_id)`.** Duplicate
  invites produce duplicate rows and duplicate notifications. Inert today because
  accepting clears all of the invitee's pending invites.
- **The public profile route is the only unauthenticated, un-rate-limited route in
  the app**, and it runs a four-table join per anonymous hit. Reviewed and accepted:
  the join is keyed on a primary key with at most one result row, so the exposure is
  amplification at request rate, not enumeration. Revisit before deployment.
- **`RegisterRequestSchema.email` has no explicit `noNulByte` guard.** It is safe
  only *incidentally*, because zod's `.email()` regex happens to reject NUL — verified
  independently across local-part, domain, leading and trailing positions. Fragile
  against a zod bump that loosens the regex.
- **Leaderboard scores above 2^53.** Redis sorted-set scores are IEEE doubles;
  balances are deliberately `bigint` because V2's signed-32-bit ceiling was a real
  problem in long-running games. Documented but *not enforced* — no GL3 value
  approaches it yet. Revisit before any real deployment; silent truncation would be
  a genuine defect for exactly the games that motivated `bigint`.
- **`ledger.test.ts`'s 200-op test runs 4.0–4.2s** against vitest's 5000ms default.
  It has never failed, but it is the closest remaining timing margin. Watch it.
- **`npm audit` reports dev-only findings**, all transitive via `vitest@2.1.9`
  (including one critical). Clearing them needs a vitest 2.x → 4.x major bump, which
  is a deliberate decision nobody has taken yet. Note that npm audit's *suggested*
  fix for the drizzle-kit findings is a **downgrade to 0.18.1 that would reintroduce
  a SQL-injection CVE** — do not follow it.

**Resolved, but the reasoning matters if you touch these areas:**

- Test databases are cloned from a pre-migrated **template** with
  `STRATEGY = WAL_LOG`. Postgres' default `FILE_COPY` serialises concurrent
  `CREATE DATABASE` (10.3s vs 0.28s for 14 clones).
- `vitest.workspace.ts` splits tests into four projects by actual need
  (`unit` / `redis-only` / `db-only` / full) so unit tests create no database at all.
- `hookTimeout` in the **root** `vitest.config.ts` is a **no-op** for workspace
  projects — it must be set per-project. (`maxWorkers`/`minWorkers` are pool-level
  and *do* apply from root.) This was proven empirically, not assumed.
- Leaderboard Redis keys are namespaced per `bootTestServer()` call; production
  keeps the global keys, which is correct there.
