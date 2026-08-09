# GL3 — working notes for Claude

GL3 is a TypeScript reimplementation of **Gangster Legends V2**, a PHP 5.6-era MySQL
browser game (PBBG) with a large installed base of live games. `SPEC.md` is the
source of truth for *what* to build. This file is the source of truth for *how* to
work in this repo without rediscovering things the hard way.

**Read before starting work:** `SPEC.md`, then `docs/STATUS.md` (where the project
is), then `docs/ENGINEERING-NOTES.md` (why the code looks the way it does).

---

## Current state

M0, M1, M2 and M3 are complete. M5 (plugin SDK) is in progress: the foundation
(SDK + loader + example) and the web page renderer have shipped; the `game/*`
module ports are pending. M4 (migration CLI) is planned and blocked on a
MariaDB install. Suite: **65 files / 557 tests**, green across repeated
back-to-back runs.

Full detail, including how to start M4, is in `docs/STATUS.md`.

---

## Environment (this machine)

**Docker is not available.** PostgreSQL 16.14 and Redis 7.0.15 run natively as
system services. `docker-compose.yml` stays in the repo as the documented path for
machines that do have Docker, but do not try to use it here.

**Container images are built in CI only.** `Dockerfile.server` and
`Dockerfile.web` (plus `apps/web/serve.mjs`, the zero-dep static server the web
image runs) cannot be built or validated on this machine — Docker Desktop's WSL
integration is off. The CI `images` job (`ci.yml`) builds both on every PR
(push disabled) and publishes them to GHCR on push to `main`. Every Dockerfile
change costs a CI round trip; `npm run typecheck` + `node apps/server/dist/index.js`
locally cover everything the image does *except* the container build itself.

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify          # typecheck + full suite — run this LOCALLY before committing
```

**GitHub CI does not run the integration suite.** Its `verify` job runs
`npm run verify:ci` (typecheck + the `@gl3/server:unit`, `@gl3/shared`,
`@gl3/plugin-sdk` and `@gl3/web` projects) with no Postgres or Redis service
containers. A green build proves the
tree typechecks and the no-DB tests pass — it is **not** evidence that the
integration suite passes. That check only exists on your machine, and it is on
you to run it. CI's second job, `images`, builds and (on `main`) pushes the two
container images — the one check that *cannot* run locally, since Docker is
unavailable here.

- Spare databases `gl3_a`..`gl3_d` exist for concurrent agents, but are **only
  migrated through `0002`** — anything touching an M3 table fails there with
  `42703 column "gang_id" does not exist`. Migrate one before relying on it.
- **This box has 32 CPUs but only ~3.8 GB RAM.** `maxWorkers` is capped at 6 in
  `vitest.config.ts` for that reason. Do not raise it.
- **Never run two full test suites at once** — including your own verification run
  alongside an agent's. Overlapping runs produce hook timeouts and cross-talk that
  look exactly like real regressions and have twice sent people chasing ghosts.
- **Never run `FLUSHALL` / `FLUSHDB`.** Redis is shared across every test file and
  every concurrent agent; flushing destroys sessions, cooldowns, rate-limit buckets
  and BullMQ state belonging to other work.
- MariaDB is **not** installed and is only needed for M4 (see `docs/STATUS.md`).
  GL3 itself is Postgres-only.

---

## The six rules that have each already caused a real bug here

1. **BullMQ is at-least-once.** Any worker that mutates the economy needs an
   idempotency key tied to `job.id`, inserted **first** inside the transaction. A
   seed makes the *outcome* reproducible; it does nothing to stop already-committed
   side effects being re-applied. M1 shipped a double-pay bug from exactly this.
   Reference: `crime_log.job_id` UNIQUE, used in `game/crimes/worker.ts`.

2. **Never check-then-act on Redis.** Use `SET NX EX`, `GETDEL`, or Lua. Two bugs
   have shipped from this shape (a rate limiter that could lock an IP out
   permanently, and a would-be replayable WebSocket ticket).

3. **Every balance movement goes through `applyBalanceChange`** (`economy/ledger.ts`)
   — one transaction, one ledger row, `bigint` throughout, no floating point.
   `sum(ledger) == balance` is enforced by `test/economy-invariant.test.ts`.

4. **Tests asserting on `game:events` must filter by their own `actorId`.** The
   channel is global across test files; matching on event type alone captures
   another file's traffic. Use `awaitOwnEvent()` from `test/helpers/events.ts`.
   Five files had this bug before it was found.

5. **Publish events only after the transaction commits.** Events are facts, not
   commands — never publish inside `db.transaction(...)`.

6. **A foreign key is a lock.** Inserting a row whose FK references another row
   takes `FOR KEY SHARE` on it, which conflicts with `FOR UPDATE`. No lock call
   appears in the code, so lock-order bugs here are invisible to a reader checking
   only the explicit locks — read the FKs too. M3 shipped a deadlock (`40P01`,
   surfacing as HTTP 500 on a well-formed request) because the membership routes
   locked `player_stats` first and reached `gangs` implicitly through a `gang_logs`
   insert, inverting the bank routes' order. Every gang↔player path now goes through
   `lockGangAndPlayerForUpdate` (`economy/ledger.ts`); regression test:
   `test/gang-lock-order.test.ts`.

   Corollary for tests: a concurrency test whose participants all acquire locks via
   the same helper proves only the case that was already safe. The pre-existing
   deadlock test agreed on ordering *by construction* and stayed green through this
   bug for that reason.

---

## Conventions

- TypeScript strict. **No `any` in `packages/*`** — none, not even a cast. In
  `apps/*` prefer `unknown` plus a zod parse, and type guards over casts.
- ESM only; relative imports carry a `.js` extension despite `.ts` sources.
- Zod-validates **every** external boundary — HTTP bodies, **route params**, WS
  frames both directions, and bus messages. An unvalidated UUID param reaches
  Postgres and 500s instead of returning a clean 400.
- Money is `bigint` in Postgres and TypeScript, and crosses the wire as a **decimal
  string** (`MoneySchema`). Never a JSON number — that reintroduces floating point.
- Bigint column defaults must be written `` .default(sql`0`) ``, never
  `.default(0n)`; drizzle-kit's serialiser crashes on `BigInt`.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue
  or bus paths, ever.
- Conventional Commits.

---

## Working method

Work is executed by subagents, one task at a time, against a written plan in
`docs/superpowers/plans/`. What has repeatedly mattered:

- **Verify every agent report against the repo yourself.** Reports have been wrong
  about test counts, and half-finished work has been reported as done. Running the
  suite yourself has caught failures an agent called green — twice.
- **"Went idle" does not mean finished.** Idle means momentarily not executing.
  Before replacing or overlapping an agent, *ask it*. Three separate incidents came
  from inferring an agent's state instead — once with three agents live on one file.
- **Ask agents to diagnose before fixing.** A plausible-sounding hypothesis
  (`argon2id is slow`) once nearly buried the real cause (a redundant 2.3-second
  `TRUNCATE`). Instrumentation beats intuition.
- **Demand proof a test can fail.** A green acceptance test that was never shown
  turning red proves nothing.
- **Flaky means broken.** Load-dependent failures here have always had real causes:
  shared BullMQ queue names, unfiltered event listeners, duplicated truncates.
