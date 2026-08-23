# Create a plugin

> **Audience:** a contributor who has the server running and wants to add a gameplay
> feature as a plugin under `packages/plugins/`.

## What a plugin is

A plugin is a self-contained package under `packages/plugins/<id>` that the server
loads at boot. It owns its database tables (prefixed `p_<id>_`), its routes, its
settings namespace, and its events. Twenty plugins ship with the repo (combat,
detectives, travel, inventory, gangs, casino, ...); use a recent one as your model.

## Workspace plugin vs installed plugin

How a plugin is wired in depends on how it arrives:

- A **workspace-local** plugin (developed in this repo) has **eight registration
  sites**, three of which fail silently or only in CI. See the checklist below.
- A plugin **installed from the registry** (`npm.gl3.dev`) needs exactly two: a
  dependency in `apps/server/package.json` and `npm run plugins:generate`, which
  rewrites the generated `apps/server/src/plugins/installed-plugins.ts`. Those two
  serve a from-source deployment only.
- In the **Docker deployment** the runtime stage has no toolchain, so a plugin
  arrives through `PLUGIN_PACKAGES` + `PLUGIN_DIR` (`plugins/dynamic.ts`), resolved
  and zod-validated at boot, needing zero registration sites and no image rebuild.
  Consequence: a dynamically loaded plugin brings its own `@gl3/plugin-sdk` copy,
  so never use `instanceof` on an SDK error class across the plugin/core boundary.
  Use `isPluginError` and its siblings.

## The eight registration sites (workspace plugins)

1. `packages/plugins/<id>/` itself
2. `apps/server/package.json` (+ `npm install`)
3. `apps/server/tsconfig.json` references
4. root `tsconfig.json` references
5. `vitest.workspace.ts` `srcAliases`
6. `plugins/core-plugins.ts`
7. the old `app.ts` registration to delete
8. five separate COPY lines in `Dockerfile.server`
   (`grep -c "packages/plugins/<id>" Dockerfile.server` should print 5)

Missing the `apps/server/tsconfig.json` reference or a Dockerfile COPY fails **only
in CI**; catch the first locally with
`npx tsc --build --force apps/server/tsconfig.json`, the exact command the image
build runs. Missing the `srcAliases` entry fails **nothing** and silently grades the
last `tsc --build` against a stale `dist/`.

There is a ninth site that is per *test file*, not per plugin: every new test file
must be listed in `vitest.workspace.ts`'s explicit `include` lists. See
[Testing conventions](/guides/testing-conventions).

## Migrations

- Plugin migrations live inside the plugin package; tables are prefixed `p_<id>_`.
- One statement per migration file.
- Settings are read at boot (settings snapshot posture). If a value must survive a
  later retune, materialise it on the row at write time rather than computing it at
  read time.

See [Add a migration](/guides/add-a-migration).

## Settings

`ctx.settings` prepends the calling plugin's own id: a plugin **cannot** read another
plugin's settings namespace. If another plugin needs a value derived from your
settings, materialise it in a column or expose it via an exported helper.

## Schema mirrors

A plugin that reads core tables (e.g. `locations`) declares a mirror in its own
`schema.ts` containing only the columns it reads. `detectives` and `combat` are the
worked examples.

## Depending on another plugin

Plugin-to-plugin dependencies are **read-only exported helpers** from the
dependency's manifest module (the pattern set by combat→inventory's `itemPriceAt`
and combat→detectives' `activeReportTargetIds`):

- The depending plugin adds the dependency to its `package.json`.
- The helper takes a `PluginTx` and does plain SELECTs: no locks, no writes into the
  other plugin's tables.
- The dependency must not learn about its dependents; the arrow points one way.

## Locks and foreign keys

**A foreign key is a lock.** Inserting a row whose FK references another row takes
`FOR KEY SHARE` on it, which conflicts with `FOR UPDATE`, and no lock call appears
in the code, so read the FKs too. All cross-entity locking goes through the shared
helpers (`lockGangAndPlayerForUpdate`, `lockLocationForUpdate` /
`lockLocationsForUpdate`, `lockPlayersForUpdate`, `tx.locks.*`), which fix the
ordering: locations before players, sorted ascending within a set. If your plugin
adds a new lock edge, it needs a lock-order regression test; if it provably adds no
new edge, record that audit in the design doc instead. The full rule with its bug
history is rule 6 in `NOTES.md`.

## Routes and errors

- Zod-validate every external boundary: HTTP bodies, route params, WS frames both
  directions, and bus messages.
- Plugin routes under `/api/admin/` must declare `auth: "admin"` (enforced at boot);
  plugins claim `/api/admin/<pluginId>`.
- Advisory reads (listing routes) may go stale; mutating routes re-check everything
  under the transaction's locks.
- Refusals are single, unexplained snake_case codes. Don't build oracles that let a
  caller probe *why* something was refused. Document new codes in
  [Error codes](/reference/errors).
- Money is `bigint` end to end and crosses the wire as a decimal string
  (`MoneySchema`), never a JSON number. Every balance movement goes through
  `applyBalanceChange` (`economy/ledger.ts`).
- Publish events only after the transaction commits, and give any
  economy-mutating worker an idempotency key tied to `job.id` (BullMQ is
  at-least-once).

## Tests

See [Testing conventions](/guides/testing-conventions). Every plugin lands with a
test file registered in `vitest.workspace.ts`'s explicit include list.

## Publishing

Before a plugin goes to the registry it passes the hand audit in
[Review a plugin](/guides/review-a-plugin) — write against its checklist from
the start rather than discovering the lock-order rules at review time.
