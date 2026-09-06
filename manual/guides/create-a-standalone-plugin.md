# Create a standalone plugin

> **Audience:** an author building a plugin as its own npm package
> (`@gl3-plugins/<id>`) from a directory outside the GL3 checkout, to publish on
> `npm.gl3.dev` and install into a running deployment. If you are adding a plugin
> *inside* this repository under `packages/plugins/`, see
> [Create a plugin](./create-a-plugin.md) instead; its registration sites do not
> apply here.

## Prerequisites

- Node 22.4 or newer and npm.
- A PostgreSQL 16 you can create throwaway databases on. The generated tests
  run against a real database, never a mock. On the GL3 dev box that is the
  **native** service on `localhost:5432`, not a container.
- Read access to `npm.gl3.dev` for `@gl3/plugin-sdk`, and publish access for
  your `@gl3-plugins/*` scope when you get to shipping.

## 1. Scaffold

```sh
npx --registry=https://npm.gl3.dev @gl3/create-plugin <id>
```

`<id>` is lowercase kebab-case, 2 to 32 characters. It becomes the package name
`@gl3-plugins/<id>`, the route base paths `/api/<id>` and `/api/admin/<id>`, and
the table prefix `p_<id>_` with hyphens turned to underscores (`my-thing` owns
`p_my_thing_*`).

The `--registry` flag is load-bearing: it routes every fetch, including the
scaffold's lookup of the current SDK version, through the marketplace host.

Options:

| flag | effect |
|------|--------|
| `[dir]` | target directory, default `gl3-plugin-<id>`; must be absent or empty |
| `--no-install` | write files and `git init`, skip `npm install` |
| `--sdk <range>` | pin the `@gl3/plugin-sdk` peer range instead of reading it from the registry |

The scaffold writes the tree, runs `git init` on `main` with no commit, and
installs dependencies. Exit code 1 means nothing was written (bad id, or the
directory is in use); 2 means the tree is there but `npm install` failed, rerun it
in the directory; 3 means an unexpected failure left a partial tree, remove it
before retrying.

## 2. What you have

```
src/index.ts          the manifest: id, version, apiVersion, basePaths, and empty lists
src/schema.ts         your own p_<id>_* tables plus read-only mirrors of core tables
src/migrations.ts     ordered migration statements the engine replays at boot
test/helpers.ts       makeHarness(): a real-Postgres harness that replays your migrations
test/manifest.test.ts, test/pack.test.ts   ship-blocking checks
scripts/e2e-dynamic.md   the pre-publish boot checklist
```

The manifest is the only wiring. A route, page, event or table you write and do
not list in `definePlugin({...})` does not exist: no error, no page. The manifest
schema is strict, so an unknown key throws at import, and `apiVersion: 1` is
checked before anything else so an SDK mismatch fails with a clear message.

## 3. Run the tests

```sh
createdb gl3_<id_snake>_test
TEST_DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3_<id_snake>_test npm test
npm run typecheck
```

`resetDb` in `test/helpers.ts` drops every `p_<id>_*` table, recreates a small
core subset (`players`, `settings`), and replays `MIGRATIONS`. When your plugin
mirrors another core table in `src/schema.ts`, add its `CREATE TABLE IF NOT
EXISTS` to `CORE_SUBSET` there with only the columns you use.

Keep `manifest.test.ts` and `pack.test.ts` green. Add one test file per
behaviour beside them.

## 4. Write the plugin

The rules are the same as for a workspace plugin, and the audit in
[Review a plugin](./review-a-plugin.md) is what a published package is graded
against. The short list:

- Every balance movement goes through `tx.economy.applyBalanceChange`.
- Money touching two players takes one sorted `tx.locks.player([a, b])` before
  any write. A foreign key is a lock; read
  [Create a plugin](./create-a-plugin.md#locks-and-foreign-keys).
- Core tables are read-only mirrors. Your writes go to `p_<id>_*` only.
- Routes under `/api/admin/<id>` declare `auth: "admin"`.
- Zod-validate every body, param and query.
- Cross-plugin extension is by name: subscribe to a filter point
  (`combat.killResolved`, `casino.games`, `core.hud`, ...) or export a
  read-only helper. See the extension surface section of
  [Create a plugin](./create-a-plugin.md#extension-surface).

Because a dynamically loaded plugin bundles its own copy of `@gl3/plugin-sdk`,
never use `instanceof` on an SDK error class; use `isPluginError` and its
siblings.

## 5. Boot the real engine once

The unit harness proves your tables and routes in isolation. Before publishing,
load the built package into a real server exactly the way an operator will:

```sh
npm run build && npm pack
mkdir -p /tmp/<id>-plugins && cp .npmrc /tmp/<id>-plugins/
npm i --prefix /tmp/<id>-plugins ./gl3-plugins-<id>-0.1.0.tgz
DATABASE_URL=postgres://gl3:gl3@localhost:5432/<spare-db> REDIS_URL=redis://localhost:6379 \
  PLUGIN_DIR=/tmp/<id>-plugins PLUGIN_PACKAGES=@gl3-plugins/<id> node apps/server/dist/index.js
```

Use a spare database migrated to head, never the `gl3` database, and do not run
this while any test suite is running on the machine. Expect the boot log to show
your migrations applied and routes registered, then drive one real round trip
through the API. `scripts/e2e-dynamic.md` in the generated package is the
checklist; record the run there under a dated heading.

## 6. Publish and install

```sh
npm run typecheck && npm test      # read the exit code, not the summary
npm publish
```

`publishConfig` in the generated `package.json` already targets `npm.gl3.dev`,
and `prepack` builds `dist/`. Bump `version` in both `package.json` and the
manifest together; `manifest.test.ts` fails when they disagree.

Installing into a deployment is the operator's step, described in
[Installing plugins](../operators/installing-plugins.md): install the package
into `PLUGIN_DIR` before the server starts, then name it in `PLUGIN_PACKAGES`.
