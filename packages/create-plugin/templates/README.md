# @gl3-plugins/__ID__

Scaffolded by `@gl3/create-plugin`. An empty GL3 plugin: the manifest in
`src/index.ts` declares nothing yet, and the test harness in `test/helpers.ts`
is ready for the first route.

## Develop

```sh
createdb gl3___ID_SNAKE___test        # on the NATIVE postgres, not a container
TEST_DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3___ID_SNAKE___test npm test
npm run typecheck
```

`test/manifest.test.ts` and `test/pack.test.ts` are ship-blocking; keep them
green. Add one test file per behaviour beside them, using `makeHarness` from
`test/helpers.ts`.

## Rules you are graded on

Read before the first route: the `writing-gl3-plugins` skill and GL3's
`manual/guides/review-a-plugin.md` (five economy checks) and `CLAUDE.md`
(the six rules — rule 6, *a foreign key is a lock*, decides your schema).

- Every balance movement goes through `tx.economy.applyBalanceChange`.
- Two players' money: one sorted `tx.locks.player([a, b])` before any write.
- Own tables are `p___ID_SNAKE___*`; core tables are read-only mirrors in `src/schema.ts`.
- Everything you write must be **declared** in the manifest — an undeclared
  page or route simply does not exist.

## Ship

```sh
npm run typecheck && npm test      # read the exit code, not the summary
npm run build && npm pack
```

Then boot the engine once against a **spare** database with
`PLUGIN_DIR=<dir containing this install> PLUGIN_PACKAGES=@gl3-plugins/__ID__`
and drive one real round trip — see `scripts/e2e-dynamic.md`. Only then
`npm publish`.
