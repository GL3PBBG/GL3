# Testing conventions

> **Audience:** a contributor writing or reviewing tests.

## Register the file, or it never runs

`vitest.workspace.ts` enumerates test files **explicitly** in each project's
`include`. A new `apps/server/test/*.test.ts` that is not listed there is invisible
to every run: `npx vitest run <path>` exits 1 with "No test files found" and no
other hint, and `npm run verify` stays green without it, so a file can sit committed
and never execute. Put new files in the project matching what they touch:
`@gl3/server:unit` for pure functions, `@gl3/server:db-only` / `redis-only` for
single-backend tests, and the default `@gl3/server` project for `bootTestServer` /
`testDb` files.

## Real backends, template databases

- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue
  or bus paths, ever.
- Each test file clones a template database built from *core* migrations only
  (`test/helpers/global-setup.ts`). Plugin tables appear only when `loadPlugins` →
  `runPluginMigrations` runs. **A test that drives a plugin without
  `bootTestServer()` must run that plugin's migrations itself** with
  `await runPluginMigrations(db, [thePlugin])`, or every test in the file dies on
  42P01. Include transitive dependencies: a combat test also needs `inventory` and
  `detectives`; `casino-rogue-game.test.ts` needs `properties` because `ownerAt`
  reads its table on every hand.

## Events

- **Tests asserting on `game:events` must filter by their own `actorId`.** The
  channel is global across test files; matching on event type alone captures
  another file's traffic. Use `awaitOwnEvent()` from `test/helpers/events.ts`.
- Adding a variant to `GameEvent` breaks four places, and only the two web-side
  exhaustive switches are type errors. The `CORPUS` drift guard
  (`plugin-ctx-core-events.test.ts`) and the census `Set` in
  `packages/shared/test/events.test.ts` fail only under the full integration
  suite, so widening the union means running all of `npm run verify`, not a
  task-scoped subset.

## What to test

- Route behaviour through the public API, not internal functions, where practical.
- Error cases assert their exact error code (`no_detective_report`, not "a 409").
- Side effects that must *not* happen are asserted too: "the cooldown is burned",
  "the report row is not consumed".
- Check-order guarantees that are part of a design get a pinning test (e.g. a
  gangmate in an underground town still sees `same_gang`).

## Invariants and lock order

- `test/economy-invariant.test.ts` enforces `sum(ledger) == balance`. Any design
  that moves money extends it; a design that doesn't should say so.
- Lock-order regression tests exist per lock edge (thirteen at last count:
  `gang-`, `travel-`, `combat-`, `theft-`, `properties-`,
  `properties-consumer-`, `casino-`, `casino-table-`, `bounties-`,
  `bullets-restock-`, `oc-`, `rounds-` and `sentence-sweeper-lock-order`; run
  `ls apps/server/test/*lock-order*` for the live list). A new lock edge needs one; a provably absent edge
  gets an audit note in the design doc instead, because a test whose participants
  all lock via the same helper proves only the already-safe case.

## Running

```sh
npm run verify        # typecheck + full suite; needs Postgres and Redis
npm run test:nodb     # the projects that need no backends (what verify:ci runs)
npm run verify:related  # typecheck + tests related to changed files
```
