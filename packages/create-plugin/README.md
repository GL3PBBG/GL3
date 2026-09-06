# @gl3/create-plugin

Scaffolds an empty **standalone** GL3 plugin package (`@gl3-plugins/<id>`) that
builds against the published `@gl3/plugin-sdk` and ships to `npm.gl3.dev` on its
own. It is for authors working *outside* the GL3 engine checkout; a plugin that
lives inside this workspace under `packages/plugins/` is wired by hand instead
(see `manual/guides/create-a-plugin.md`).

```sh
npx --registry=https://npm.gl3.dev @gl3/create-plugin <id>
```

The `--registry` flag matters: it routes every fetch the scaffold makes, the
SDK version lookup included, through the marketplace host. The package has zero
runtime dependencies for that reason.

## Usage

```
create-plugin <id> [dir] [--no-install] [--sdk <range>]

  <id>          plugin id: lowercase kebab-case, 2-32 chars (/^[a-z][a-z0-9-]*$/)
                becomes @gl3-plugins/<id>, p_<id with - as _>_*, /api/<id>, /api/admin/<id>
  [dir]         target directory (default: gl3-plugin-<id>); must be absent or empty
  --no-install  write files and git init, skip npm install
  --sdk <range> peerDependencies range for @gl3/plugin-sdk (default: read from npm.gl3.dev)
```

What one run does, in order:

1. Validates the id and refuses a target directory that exists and is not empty.
2. Resolves the SDK peer range: `--sdk` verbatim if given, else `^<version>` from
   `npm view @gl3/plugin-sdk version --registry=https://npm.gl3.dev`, else the
   baked fallback in `src/sdk-version.ts` with a warning on stderr.
3. Renders `templates/` into the target, substituting three tokens: `__ID__`,
   `__ID_SNAKE__` (hyphens as underscores, the table prefix the engine expects)
   and `__SDK_RANGE__`. `_npmrc` and `_gitignore` become dotfiles on the way out,
   because npm strips real dotfiles from a tarball.
4. `git init --initial-branch=main`, no commit. A missing git is a warning.
5. `npm install --no-audit --no-fund` unless `--no-install`.
6. Prints the next steps: create a throwaway database on the native Postgres and
   run the generated tests against it.

Exit codes:

| code | meaning |
|------|---------|
| 0 | scaffolded |
| 1 | bad arguments, or the target exists and is not empty (nothing written) |
| 2 | files written and git initialised, but `npm install` failed; rerun it in the directory |
| 3 | unexpected failure after validation; the tree may be partial, remove it before retrying |

## What gets generated

```
.gitignore  .npmrc  README.md  package.json  tsconfig.json  vitest.config.ts
src/index.ts         the manifest, declaring nothing yet (id, version, apiVersion, basePaths)
src/schema.ts        own tables (p_<id>_*) plus read-only mirrors of core tables
src/migrations.ts    the plugin's migration list
test/helpers.ts      makeHarness: a real-Postgres harness that replays MIGRATIONS
test/manifest.test.ts, test/pack.test.ts   ship-blocking checks (version parity, tarball contents)
scripts/e2e-dynamic.md   checklist for booting the built engine with PLUGIN_DIR + PLUGIN_PACKAGES
```

`src/scaffold.ts` keeps the canonical list in `GENERATED_FILES`; extend it when
a template is added, the scaffold tests assert against it.

## Working on the scaffolder

This is a workspace package, not a plugin, so none of a plugin's registration
sites apply. It has three of its own: a root `tsconfig.json` reference, the
`@gl3/create-plugin` vitest project in `vitest.workspace.ts`, and an entry in
the root `test:nodb` script (which is what CI's `verify:ci` runs).

```sh
npm run build -w @gl3/plugin-sdk          # generated-plugin.test.ts typechecks against the real dist
npm run build -w @gl3/create-plugin
npx vitest run --project @gl3/create-plugin
```

`templates/` sits outside every tsconfig `include`; it is data, not source. The
only typecheck it gets is `test/generated-plugin.test.ts`, which renders a plugin
into a scratch directory and runs `tsc --build` against `packages/plugin-sdk/dist`.
A template change that breaks against the workspace SDK fails there.

Tests:

- `test/cli.test.ts`: argv parsing, exit codes, the bin runs `main` once.
- `test/scaffold.test.ts`: id validation, token rendering, dotfile renames, `GENERATED_FILES`.
- `test/sdk-version.test.ts`: range resolution order and the fallback warning.
- `test/generated-plugin.test.ts`: the rendered package typechecks and its manifest parses.

## Publishing the scaffolder

1. Restamp `BAKED_SDK_RANGE` in `src/sdk-version.ts` from
   `npm view @gl3/plugin-sdk version --registry=https://npm.gl3.dev`, so the
   offline fallback never drifts far behind the SDK.
2. Bump `version` in `package.json`.
3. `npm publish -w @gl3/create-plugin` (`publishConfig` already targets `npm.gl3.dev`;
   `prepack` builds `dist/`, and `files` carries `bin`, `dist` and `templates`).
4. Prove it from an empty directory with the `npx --registry` one-liner above,
   then `npm test` inside the result against a throwaway database.
