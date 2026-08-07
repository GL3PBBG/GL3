# GL3 project status

Last updated: 2026-08-07, after M2 completion.
Branch: `feat/m0-m1-scaffold-and-vertical-slice` (58 commits ahead of `main`).

---

## Milestones

| Milestone | State | Notes |
|---|---|---|
| **M0 Scaffold** | ✅ complete | Monorepo, CI, docker-compose, all 32 tables migrated |
| **M1 Auth + vertical slice** | ✅ complete | Acceptance criterion proven end to end |
| **M2 Core loop parity** | ✅ complete | `sum(ledger) == balance` gate passing |
| **M3 Social** | 📋 planned, not started | 10 tasks — **ready to execute now** |
| **M4 Migration CLI** | 📋 planned, blocked | 33 tasks — needs a MariaDB install (below) |
| **M5 Plugin SDK** | ❌ not planned | Now unblocked; refactors M2's bank into a plugin |

**Suite: 22 files / 126 tests**, verified green across four consecutive
back-to-back runs on a loaded machine.

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

Every balance movement anywhere is an append-only ledger row inside the same
transaction as the balance update.

---

## Starting M3

The plan is written and ready: `docs/superpowers/plans/2026-08-07-gl3-m3-social.md`
(10 tasks). M3 covers gangs (create / invite / roles / bank / logs), mail,
notifications, profile, and game news.

**Acceptance criterion (SPEC §6):** gang bank transfers ledgered; WS notifies
invitees live.

Before dispatching anything, read `CLAUDE.md` and `docs/ENGINEERING-NOTES.md`.

Extract a task brief with:

```bash
.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/\
subagent-driven-development/scripts/task-brief \
  docs/superpowers/plans/2026-08-07-gl3-m3-social.md 1
```

### Things M3 will hit that are worth knowing in advance

- **Gangs have two balances** (`gangs.bank` and `gangs.cash`), preserved from V2's
  `G_bank` / `G_money`.
- **Gang bank transfers move money between a player and a gang.** That is a
  two-party mutation, so lock rows in a consistent order — and note the ordering
  precedent already set: the bullets shop locks **location before player**. Keep any
  new ordering consistent with that, or SPEC §2.3's deadlock guarantee breaks.
- **`gang_permissions` has a real `gang_id`** in GL3; V2's `gangPermissions` had
  none and implied the gang from the member's `US_gang`.
- **The `gang` audience already exists** in the WS gateway and resolves members via
  `gang_members`. Use it rather than adding game rules to the gateway — the gateway
  routes purely on `event.audience` and knows nothing about features.
- **The event names already exist** in `GameEventSchema`: `gang.created`,
  `gang.memberJoined`, `gang.memberLeft`, `mail.received`, `notification.created`,
  `news.posted`. Wire them up; don't invent new names.
- Mail is threaded (V2's `M_parent` → `thread_id`).

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
