# Dynamic plugin loading (option B)

**Branch:** `claude/gl3-gangster-legends-comparison-um24t7`
**Why:** GL3 deploys as Docker. `Dockerfile.server`'s runtime stage carries only
compiled `dist/` dirs plus the `node_modules` that `npm ci` resolved at *build*
time, and `installed-plugins.ts` is compiled into `apps/server/dist`. So an
operator cannot install a third-party plugin at all without rebuilding the
image — and the image's plugin COPY lines only cover our own workspace
packages. `npm i` is not the install path for anybody who deploys the way we
deploy.

**Shape:** a package named in `PLUGIN_PACKAGES` is `await import(...)`ed at
boot, resolved out of an operator-controlled directory (`PLUGIN_DIR`, a mounted
volume), and its default export is validated as a manifest at runtime instead
of at compile time. Install becomes `npm i --prefix /data/plugins @acme/x` in
an init container — the same slot the migration initContainer already occupies
— plus an env var and a restart. No image rebuild.

## The objection, and why it does not apply here

`index.ts:20` and `generate-plugin-map.mjs` both state the rule: a static
import is what keeps the plugin→core dependency direction checkable by the
compiler, and `import(pluginId)` bypasses it. That rule is kept for
`CORE_PLUGINS` and for compiled-in optional plugins, which is where it earns
its keep — those are *our* sources, typechecked in *our* build.

It buys nothing for a registry package. A third-party plugin ships prebuilt
`dist/` + `.d.ts`; `tsc` never sees its sources, so the only thing the static
import checks is that its default export structurally matches
`PluginManifest`. A zod parse at load does that same job against what actually
shipped rather than against a declared type. Nothing is lost, and the failure
moves earlier and gets a name attached.

## The hazard this must close first

Two module instances of `@gl3/plugin-sdk` will exist: ours under `/app`, and
the plugin's own under `/data/plugins`. `plugins/routes.ts:93` maps a plugin's
thrown error to its HTTP status with `error instanceof PluginError`. Across
two instances that is `false`, so every deliberate 400/409/423 from a
dynamically loaded plugin would become a **500**. The SDK already documents
exactly this failure mode for zod (`events.ts:14`, duck-typed on purpose);
this extends the same discipline to its own error classes.

Not fixing this first would ship the feature broken in precisely the
configuration it exists to serve.

`filterPoint`'s `declared` Set is also per-instance, which weakens its
duplicate-name check across the boundary. That is acceptable and is left
alone: `runFilterChain` routes by name *string*, so cross-instance filters
still work, and the loader's own collision pass covers what matters.

## Tasks

1. **SDK — `parsePluginManifest(value: unknown): PluginManifest`.** Lift the
   body of `definePlugin` into it; `definePlugin` becomes the typed wrapper.
   One schema, two entry points, no duplication. `InputSchema` already accepts
   a fully-normalised manifest (its optional fields accept present values), so
   this needs no second schema.
2. **SDK — structural error identification.** Brand `PluginError`,
   `InsufficientFundsError`, `InsufficientGangFundsError` and
   `JobAlreadyAppliedError` with `Symbol.for(...)` keys and export
   `isPluginError` / `isInsufficientFundsError` /
   `isInsufficientGangFundsError` / `isJobAlreadyAppliedError` guards. Each
   guard accepts the brand **or** the legacy `name`+shape duck-type, so
   plugins already published against `0.1.0`–`0.1.8` (which carry no brand)
   keep working.
3. **Server — use the guards.** `routes.ts:93` and `jobs.ts:94` switch off
   `instanceof`. `ctx.ts:129/153` stay on `instanceof`: those catch core's own
   `economy/ledger.ts` errors thrown and caught inside core, one instance,
   never crossing the boundary.
4. **Server — `plugins/dynamic.ts`.** `loadDynamicPlugins(packages, dir)`:
   resolve each specifier, import it, take `default`, `parsePluginManifest` it,
   return `[packageName, manifest]` pairs. Resolution tries `createRequire`
   from `dir` first, then falls back to reading the package's own
   `package.json` `exports["."]`/`main` — needed because `require.resolve`
   fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` on an ESM-only exports map, which
   a modern third-party plugin may well ship. With no `dir` configured, a bare
   `import(spec)` resolves from the server's own `node_modules`.
5. **Config — `PLUGIN_PACKAGES` and `PLUGIN_DIR`.** `PLUGIN_PACKAGES` is a
   comma-separated list of package specifiers that are *loaded*, not merely
   made available: the operator named them explicitly, so there is no
   "installed but disabled" state to model. `PLUGIN_IDS` keeps its exact
   current meaning — manifest ids selecting from the compiled-in map — because
   `available.ts:7` is emphatic that an id is not a package name and nothing
   should assert the two are equal.
6. **Boot wiring in `index.ts`.** Load dynamic packages, then reject an id that
   collides with a core plugin or a compiled-in one *loudly*, naming both
   sides. `withCorePlugins` de-duplicates silently by design, which is right
   for its own case and wrong here: an operator whose `@acme/casino` is
   silently dropped has no way to find out.
7. **Tests.** A real fixture package written to disk and really imported — no
   mocks, per the repo rule. Cases: loads a good package; rejects a malformed
   manifest naming the package; rejects a missing default export; rejects an
   unresolvable specifier; resolves an ESM-only exports map through the
   fallback; a cross-instance `PluginError` still maps to its status.
8. **Docker + docs.** A `PLUGIN_DIR` mount point and the init-container recipe;
   `docs/STATUS.md`, `.env.example`, and the deployment notes.
9. **SDK version bump** to `0.1.9` (additive: two new exports plus the guards).
   Not published — publishing needs the user's approval, and `0.1.8` is already
   on the registry from another session.

## Out of scope

- Removing the per-plugin COPY lines from `Dockerfile.server`. Our own
  workspace plugins stay compiled in; this is about third-party ones.
- A plugin marketplace, signing, or sandboxing. Trust is granted at install
  time — the same model `publishCore` already documents. Loading a package an
  operator installed is arbitrary code execution by construction, exactly as
  `npm i` is.
