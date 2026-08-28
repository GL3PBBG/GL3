# Installing plugins

> **Audience:** an operator running the published container image (or a
> from-source deployment) who wants to add a plugin that is not compiled into
> the server. If you are *writing* a plugin, see
> [Create a plugin](../guides/create-a-plugin.md) instead.

## The one idea to hold on to: install ≠ load

Adding a plugin to a running GL3 deployment is **two separate steps performed
by two separate processes**, and every configuration question below falls out
of that split:

1. **Install** — `npm i` fetches the plugin package from the registry and
   writes its files to disk. This step needs an npm toolchain and registry
   credentials. It happens **before the server starts**, and never inside the
   runtime container.
2. **Load** — at boot, the server reads `PLUGIN_PACKAGES`, resolves each named
   package from files **already on disk**, imports its entry point, and
   validates its default export as a plugin manifest. This step performs **no
   network access and no npm invocation** — it is a pure read of the
   filesystem (`apps/server/src/plugins/dynamic.ts`).

So when `.env.example` says packages are "imported at boot", that is the
*load* step: the enabling act is naming the package in an env var, but the
package's files must already be sitting in `PLUGIN_DIR` when the server comes
up. If they are not, the server refuses to boot (see
[Failure modes](#failure-modes) below) rather than skipping the plugin
silently.

This split is deliberate, not an accident of packaging:

- The published runtime image carries only `dist/` output and the
  `node_modules` that `npm ci` resolved at **build** time. It ships **no npm,
  no toolchain, and no registry credentials**, so it *could not* install a
  package at boot even if asked to.
- A server that fetched code from the network at boot would be a supply-chain
  surface and a source of nondeterministic boots (registry down → game down).
  GL3's marketplace trust model is hand-audited install, not auto-fetch: a
  human (or a pipeline a human controls) decides exactly which package
  versions land on disk, and the server only ever loads what that decision
  produced. The audit itself follows the checklist in
  [Review a plugin](/guides/review-a-plugin).

## The three environment variables

From `.env.example`:

| Variable | What it does |
| --- | --- |
| `PLUGIN_IDS` | Selects among plugins **compiled into** this server build (the generated static import map). Irrelevant to externally installed plugins — do **not** add your dynamic plugin's id here. |
| `PLUGIN_PACKAGES` | Comma-separated npm package **specifiers** (e.g. `@acme/plugin-x`) to load from outside the build. Naming a package here is the enabling act; packages listed load unconditionally. |
| `PLUGIN_DIR` | The directory the packages are resolved from — in production, a mounted volume. When **unset**, packages resolve from the server's own `node_modules`, which is what a from-source deployment wants. |

Resolution looks for `<PLUGIN_DIR>/node_modules/<specifier>`, i.e. exactly the
layout `npm i --prefix <PLUGIN_DIR> <specifier>` produces. The full Node
resolution algorithm is used (including `exports` maps), with a fallback for
pure-ESM packages.

## The marketplace scopes

The marketplace registry (`npm.gl3.dev`) serves two npm scopes with opposite
access rules:

| Scope | Contents | Read access |
| --- | --- | --- |
| `@gl3/*` | The public engine core: `@gl3/plugin-sdk`, `@gl3/shared`, free plugins | Anyone, no credentials |
| `@gl3-plugins/*` | **Premium plugins** | Entitlement-gated per account |

For the paid scope, the registry asks the marketplace's entitlement service
on every request — web UI, search, and `npm install` alike — so a premium
package is invisible until your account is entitled to it. Buying a plugin
grants your marketplace account an entitlement for that exact package name
(all-access plans use the scope wildcard). Marketplace staff read every paid
package without entitlement rows; everyone else needs the row.

Logging in is standard npm: `npm login --registry https://npm.gl3.dev` with
your marketplace username and your `gl3_...` access token as the password.
The token is shown once when minted; roles and entitlements are checked live
on each request, so a newly-purchased plugin appears without re-minting the
token (at most, log in again to refresh the session).

## Registry credentials (the marketplace)

Plugins distributed through the GL3 marketplace are npm packages served from
the marketplace registry (`npm.gl3.dev`). Installing one is a normal
authenticated npm operation, which means **the install step needs npm
credentials and the running server needs none** — this is the clearest
practical consequence of the install/load split:

- The **init container** (or whatever runs `npm i`) needs the registry URL
  and an auth token: a mounted `.npmrc`, or `NPM_CONFIG_*` env vars fed from
  a Secret. Example `.npmrc`:

  ```ini
  @gl3:registry=https://npm.gl3.dev
  @gl3-plugins:registry=https://npm.gl3.dev
  //npm.gl3.dev/:_authToken=${GL3_NPM_TOKEN}
  ```

  Scoped registry lines, never a bare `registry=` — a global line would
  route every transitive dependency through the marketplace host, hiding
  npmjs behind its uplink until the day the host is down.

- The **server container** gets neither the token nor any registry
  configuration. It cannot install packages, so it has no use for
  credentials — and a compromised server process therefore has no registry
  token to exfiltrate or publish with.

Scope the token to read/install only if the registry supports it; the token
that *publishes* marketplace plugins should never appear anywhere in a game
deployment. If you mirror marketplace packages into your own private
registry (a reasonable supply-chain posture), the same applies — the mirror's
credentials live only where `npm` runs.

## Kubernetes: the init-container pattern

The intended production shape is an **init container**: a short-lived
container with an npm toolchain that runs `npm i` into a volume shared with
the server container, then exits before the server starts. It occupies the
same slot as the database-migration init container you likely already run.

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      volumes:
        - name: plugins
          emptyDir: {}          # or a PVC — see the note below
        - name: npmrc
          configMap:
            name: gl3-npmrc
            # ConfigMap key "npmrc" — no secret material in it:
            #   @gl3:registry=https://npm.gl3.dev
            #   @gl3-plugins:registry=https://npm.gl3.dev
            #   //npm.gl3.dev/:_authToken=${GL3_NPM_TOKEN}
      initContainers:
        - name: install-plugins
          image: node:22-alpine # has npm; the runtime image does not
          command:
            - npm
            - i
            - --prefix
            - /data/plugins
            - "@acme/plugin-x@1.2.3"   # pin versions — see below
          volumeMounts:
            - name: plugins
              mountPath: /data/plugins
            - name: npmrc
              mountPath: /npm
          # Registry credentials for npm.gl3.dev live HERE, not on the server.
          # The token rides an env var that npm expands inside the mounted
          # npmrc (`${GL3_NPM_TOKEN}`) — it never sits in a file or image
          # layer, and rotation is a Secret update. Note a Kubernetes env var
          # cannot be named `NPM_CONFIG_//host/:_authToken` (slashes and
          # colons are invalid in env names), which is why the npmrc file
          # carries that line instead.
          env:
            - name: NPM_CONFIG_USERCONFIG   # point npm at the mounted file
              value: /npm/npmrc
            - name: GL3_NPM_TOKEN
              valueFrom:
                secretKeyRef: { name: npm-creds, key: token }
      containers:
        - name: server
          image: ghcr.io/gl3pbbg/gl3-server:latest
          env:
            - name: PLUGIN_PACKAGES
              value: "@acme/plugin-x"
            - name: PLUGIN_DIR
              value: "/data/plugins"
            # ...DATABASE_URL, REDIS_URL, etc.
          volumeMounts:
            - name: plugins
              mountPath: /data/plugins
```

Notes on this shape:

- **`emptyDir` is fine.** Init containers rerun on every pod start, so the
  volume is repopulated fresh each time and nothing needs to survive pod
  recreation. A PVC works too and saves a registry round-trip per restart, at
  the cost of stale-content risk if you ever change the install command
  without recreating the volume.
- **Pin exact versions** (`@acme/plugin-x@1.2.3`, or better, commit a
  `package.json` + `package-lock.json` into an image/ConfigMap and run
  `npm ci --prefix /data/plugins`). An unpinned `npm i` in an init container
  means a pod rescheduled at 3am can silently pick up a newer plugin version
  than the pods that started yesterday — the exact nondeterminism this whole
  design exists to avoid.
- **Credentials stay in the init container.** The registry token for
  `npm.gl3.dev` is mounted only where `npm` runs. The server container never
  sees it, which shrinks what a compromised server process can exfiltrate.
- **Multiple plugins**: list them all in one `npm i` invocation, and put the
  same set (comma-separated) in `PLUGIN_PACKAGES`. The install and the env var
  are maintained together — a package on disk but not in `PLUGIN_PACKAGES` is
  ignored; a package in `PLUGIN_PACKAGES` but not on disk fails the boot.

### Adding, upgrading, or removing a plugin later

All three are the same operation: edit the init container's install command
and/or `PLUGIN_PACKAGES`, then roll the deployment
(`kubectl rollout restart deployment/gl3-server`). The next pod start reruns
the install and the server loads the new set. **No image rebuild, ever** —
that is the point of this mechanism. There is no live/hot reload; a restart is
always required, matching how plugin settings already behave (read at boot).

## Docker Compose equivalent

The repository's `docker-compose.yml` runs the full game under its `app`
profile (`docker compose --profile app up`), so this is a service to add
next to `server` in that file — same shape, whether you run the shipped file
or your own:

```yaml
services:
  install-plugins:
    image: node:22-alpine
    command: ["npm", "i", "--prefix", "/data/plugins", "@acme/plugin-x@1.2.3"]
    volumes:
      - plugins:/data/plugins
      - ./npmrc:/root/.npmrc:ro   # registry creds for npm.gl3.dev
    restart: "no"                 # one-shot: runs, installs, exits

  server:
    image: ghcr.io/gl3pbbg/gl3-server:latest
    depends_on:
      install-plugins:
        condition: service_completed_successfully
    environment:
      PLUGIN_PACKAGES: "@acme/plugin-x"
      PLUGIN_DIR: /data/plugins
      # ...DATABASE_URL, REDIS_URL, etc.
    volumes:
      - plugins:/data/plugins

volumes:
  plugins:
```

`service_completed_successfully` is the compose analogue of an init
container: the server does not start until the install service has exited 0.

## From-source deployments

If you run the server from a checkout with a toolchain present, you do not
need any of the volume machinery. Two options:

- **Static (compiled-in):** add the plugin to `apps/server/package.json`, run
  `npm install` and `npm run plugins:generate` (which rewrites the generated
  static import map), rebuild, restart. The plugin is then selected by id via
  `PLUGIN_IDS` like any other compiled-in plugin.
- **Dynamic without a directory:** `npm i` the package into the server's own
  `node_modules`, name it in `PLUGIN_PACKAGES`, and leave `PLUGIN_DIR`
  **unset** — the loader then resolves the specifier from the server's own
  module tree.

## What load-time validation actually checks

At boot, for each specifier in `PLUGIN_PACKAGES`, the loader:

1. Resolves the package's entry file under `PLUGIN_DIR` (or bare, if
   `PLUGIN_DIR` is unset).
2. Imports it and requires a **default export**.
3. Parses that export as a plugin manifest (zod-validated:
   `parsePluginManifest`). Routes, pages, events, migrations, settings — the
   whole declared surface is checked against the SDK schema that shipped in
   the running server.

What it does **not** check: the plugin's behaviour. A manifest that validates
can still do anything the SDK allows at runtime — including publishing core
game events to any audience (`publishCore` is unrestricted by design). Trust
is granted at **install time**, by you, when you choose to put the package on
the volume. Audit before you install; there is no runtime sandbox.

One consequence of dynamic loading worth knowing even as an operator: a
dynamically loaded plugin bundles its **own copy** of `@gl3/plugin-sdk`. That
is handled inside GL3 (error identification uses brand checks, not
`instanceof`), but it means an SDK version mismatch between plugin and server
surfaces as manifest validation errors at boot, not as subtle runtime
breakage — which is the failure mode you want.

A plugin can make that mismatch explicit by declaring `apiVersion` in its
manifest (absent means `1`, the current and only contract version). The
declaration is checked **before** the manifest's schema, so a plugin written
against a newer SDK fails with a contract error naming both versions and the
remedy — `apiVersion: plugin declares 2 but this build of @gl3/plugin-sdk
implements 1; install a plugin release built for apiVersion 1, or update the
server` — instead of a cryptic `Unrecognized key '…'` on whichever new field
happened to come first. A stale server image meeting a newer plugin used to
produce exactly that cryptic crash-loop; the field exists so it never does
again.

## Failure modes

All of these fail **loud, at boot**, before the server accepts traffic:

- **Package not on disk** (volume empty, init container skipped or failed,
  typo in the specifier):
  `cannot load plugin package "@acme/plugin-x" — not resolvable from /data/plugins (...)`
- **Package present but broken** (no default export, or the export fails
  manifest validation): the error names the package and the offending
  manifest field.
- **Plugin written against a newer plugin API contract** (manifest declares
  `apiVersion: 2` on a server that implements `1`): the error names the
  package, both versions, and the remedy — update the server or install a
  plugin release built for the server's contract. Checked before schema
  validation, so it reports the contract, not the first unknown field.
- **Init container itself fails** (bad credentials, registry unreachable,
  nonexistent version): in Kubernetes the pod never leaves `Init:Error`, so
  the old pods keep serving during a rollout — a bad plugin install cannot
  take down a healthy running deployment mid-rollout.
- **`PLUGIN_DIR` unset on the server container** — the tell is the error's
  wording: `import failed (Cannot find package '@x/y' imported from
  .../dist/plugins/dynamic.js)`. "Imported from dynamic.js" means the loader
  fell back to a bare import against the server's own `node_modules` because
  no directory was configured; the files sitting in the volume are fine,
  nothing is looking there. Set `PLUGIN_DIR` on the **server** container and
  make sure the same volume is mounted at that path on the server, not only
  on the init container. (With `PLUGIN_DIR` set, the same failure reads
  `not resolvable from /data/plugins` instead.)

Three init-container gotchas seen in the wild, none of them GL3-specific:

- **`CrashLoopBackOff` with last state `Terminated: Completed`** — the
  one-shot container is in `containers:` instead of `initContainers:`. A
  Deployment restarts any main container that exits, *even on exit 0*. Move
  it to the init list (in the Rancher UI, flip the container's
  "Init Container" toggle — a second container is added as a sidecar by
  default).
- **Install finishes but the container never exits** — npm's post-install
  tail (audit / fund / update-notifier) stalling against restricted egress.
  Run with `--no-audit --no-fund --ignore-scripts`; `--ignore-scripts` is
  also the right supply-chain posture for prebuilt plugin `dist/`. Remember
  the install needs npmjs.org reachable too (the plugin's own dependencies),
  not just the marketplace host.
- **`EINVALIDTAGNAME: Invalid tag name "{"`** — a shell snippet
  (`|| { ...; }`) pasted as separate YAML `command:` list items instead of
  one `sh -c` string; npm read `{` as a package name. The whole pipeline
  must be exactly `["sh", "-c", "<one quoted script>"]`. To capture npm's
  debug log on failure, end the script with
  `|| { cat /root/.npm/_logs/*.log; exit 1; }` so the real error reaches
  `kubectl logs` before the container dies.

There is no partial load: packages are loaded sequentially and the first
failure aborts boot naming the package that failed. A plugin you name in
`PLUGIN_PACKAGES` either loads completely or prevents the server from
starting — it is never silently absent from a running game.

## Cross-plugin constraints

Plugins that statically import another plugin declare it on their manifest
(`requires`), and the loader enforces it at boot: a boot whose set does not
satisfy every `requires` fails with an error naming the plugin and the
missing requirement, before any route serves a request. The bundled gameplay
clusters (`combat` → `detectives`; `casino` → `properties` → `combat`;
`bullets` → `properties` + `travel`; the full list is in the
[framework profile guide](./framework-profile.md)) are all covered by
declarations, so an incomplete `PLUGIN_IDS` is a boot error, not a runtime one.

That covers code dependencies. Data-driven couplings are still yours to
check — the canonical example: setting any town to `underground` combat mode
requires the `detectives` plugin to be loaded, or every attack and
target-list read in that town fails.
