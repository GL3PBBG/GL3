import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePluginManifest, type PluginManifest } from "@gl3/plugin-sdk";

/**
 * Boot-time loading of plugins that are NOT compiled into this server.
 *
 * `installed-plugins.ts` is generated from apps/server's dependencies and
 * compiled into `apps/server/dist`, which works for anyone who builds from
 * source and not at all for anyone who runs the published image: its runtime
 * stage carries only `dist/` dirs and the `node_modules` that `npm ci`
 * resolved at BUILD time, with no toolchain to rebuild either. Adding a plugin
 * there means rebuilding the image.
 *
 * A package named in `PLUGIN_PACKAGES` is instead resolved out of
 * `PLUGIN_DIR` — an operator-controlled directory, in practice a mounted
 * volume populated by an init container running
 * `npm i --prefix <dir> @acme/plugin-x`, the same slot the migration
 * initContainer already occupies. Install is then an env var and a restart.
 *
 * What this gives up, and why it is affordable: a static import lets `tsc`
 * check the plugin→core dependency direction, and that check is why
 * `CORE_PLUGINS` and the generated map are static and stay that way. It buys
 * nothing for a registry package — a prebuilt `dist/` + `.d.ts` is never
 * typechecked by our build, so the only thing the static import verified was
 * that the default export matches `PluginManifest`. `parsePluginManifest` does
 * that here, at runtime, against what actually shipped.
 */

/** A resolved package, in the shape `buildAvailablePlugins` already consumes. */
export type DynamicPlugin = readonly [packageName: string, manifest: PluginManifest];

function fail(spec: string, detail: string): never {
  throw new Error(`cannot load plugin package "${spec}" — ${detail}`);
}

/**
 * Finds the module file for `spec` under `dir`.
 *
 * `createRequire().resolve` is tried first because it implements the whole
 * resolution algorithm including `exports` maps. It fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` on an ESM-ONLY exports map (one whose "."
 * offers `import` but neither `require` nor `default`) — every GL3 plugin
 * declares `default` and resolves on the first path, but a third-party plugin
 * published as pure ESM is entirely legitimate and must not be unloadable.
 * The fallback reads that package's own manifest and takes the entry point
 * directly.
 */
function resolveFrom(dir: string, spec: string): string {
  const require = createRequire(pathToFileURL(join(dir, "package.json")));
  try {
    return require.resolve(spec);
  } catch (error) {
    const entry = entryFromPackageJson(dir, spec);
    if (entry !== null) return entry;
    const reason = error instanceof Error ? error.message : String(error);
    return fail(spec, `not resolvable from ${dir} (${reason})`);
  }
}

/**
 * The ESM-only fallback: `<dir>/node_modules/<spec>/package.json`, then its
 * `exports["."]` (`import` before `default`) or `main`.
 *
 * Deliberately shallow — it handles the one shape `require.resolve` refuses
 * and does not reimplement conditional exports. Anything more exotic returns
 * `null` and the caller reports the original resolution error, which names the
 * real problem better than a guess would.
 */
function entryFromPackageJson(dir: string, spec: string): string | null {
  const packageDir = join(dir, "node_modules", spec);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;
  const fields = manifest as Record<string, unknown>;

  const exports = fields["exports"];
  if (typeof exports === "object" && exports !== null) {
    const root = (exports as Record<string, unknown>)["."];
    if (typeof root === "string") return join(packageDir, root);
    if (typeof root === "object" && root !== null) {
      const conditions = root as Record<string, unknown>;
      for (const key of ["import", "default"]) {
        const value = conditions[key];
        if (typeof value === "string") return join(packageDir, value);
      }
    }
  }

  const main = fields["main"];
  return typeof main === "string" ? join(packageDir, main) : null;
}

/**
 * Imports one package and validates its default export as a manifest.
 *
 * With no `dir`, the specifier is imported bare and resolves from this
 * server's own `node_modules` — which is how a source deployment can name a
 * package it has already `npm i`-ed without configuring a directory at all.
 */
async function loadOne(spec: string, dir: string | null): Promise<DynamicPlugin> {
  const target = dir === null ? spec : pathToFileURL(resolveFrom(dir, spec)).href;

  let namespace: unknown;
  try {
    namespace = await import(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(spec, `import failed (${reason})`);
  }

  if (typeof namespace !== "object" || namespace === null || !("default" in namespace)) {
    return fail(spec, "the package has no default export (a plugin's manifest must be its default export)");
  }

  try {
    // Not a cast: `parsePluginManifest` takes `unknown` precisely so this seam
    // needs none. Its own error already names the offending field.
    return [spec, parsePluginManifest((namespace as { default: unknown }).default)] as const;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(spec, reason);
  }
}

/**
 * Loads every package in `packages`, in order. Sequential rather than
 * `Promise.all` so a failure names the package that failed without a race
 * between several rejections, and because boot is not a hot path.
 */
export async function loadDynamicPlugins(
  packages: readonly string[],
  dir: string | null,
): Promise<DynamicPlugin[]> {
  const absoluteDir = dir === null ? null : isAbsolute(dir) ? dir : resolvePath(dir);
  const loaded: DynamicPlugin[] = [];
  for (const spec of packages) loaded.push(await loadOne(spec, absoluteDir));
  return loaded;
}
