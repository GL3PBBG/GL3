/**
 * Generates `apps/server/src/plugins/installed-plugins.ts` — the static import
 * map of OPTIONAL plugins — from `apps/server`'s direct dependencies.
 *
 *   node scripts/generate-plugin-map.mjs           # write the file
 *   node scripts/generate-plugin-map.mjs --check   # exit 1 if it is stale
 *
 * Why generated rather than hand-written: installing a marketplace plugin must
 * not mean editing core server source, or every operator forks core and every
 * upgrade is a merge conflict in the one file they had to touch. Why static
 * imports rather than `import(pluginId)`: the static import is what keeps the
 * plugin→core dependency direction checkable by the compiler (see the comments
 * in `apps/server/src/index.ts` and `src/plugins/core-plugins.ts`). Generating
 * them keeps that guarantee and removes the edit.
 *
 * A package is included when it is a DIRECT dependency of `apps/server` AND
 * its own package.json declares `"gl3": { "plugin": true }`. Direct-only means
 * a transitive dependency can never smuggle itself into the boot; the marker
 * means no npm scope is mandated, so operators can publish under their own.
 *
 * The 14 ported core plugins deliberately carry no marker. The marker means
 * "optional, selectable via PLUGIN_IDS" — core ports load unconditionally
 * through CORE_PLUGINS and are never gated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OUTPUT_PATH = "apps/server/src/plugins/installed-plugins.ts";

const HEADER = `// GENERATED FILE — do not edit by hand.
// Rewrite with: npm run plugins:generate
//
// The optional-plugin import map. Every entry is a direct dependency of
// apps/server whose package.json declares \`"gl3": { "plugin": true }\`.
// \`PLUGIN_IDS\` selects which of these actually load; ported core modules are
// never listed here (they load unconditionally via CORE_PLUGINS).
`;

/**
 * `@gl3/hello-plugin` -> `plugin_gl3_hello_plugin`. Readable in the review
 * diff that is the whole point of committing this file, and injective for
 * every real package name — the caller checks for collisions regardless.
 */
export function toIdentifier(packageName) {
  return `plugin_${packageName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Finds every marked plugin among apps/server's direct dependencies.
 * Returns `{ packageName, identifier }[]` sorted by package name, so the
 * generated file is stable regardless of dependency insertion order.
 */
export function discoverPlugins(rootDir) {
  const serverPkg = readJson(join(rootDir, "apps/server/package.json"));
  const depNames = Object.keys(serverPkg.dependencies ?? {}).sort();

  const found = [];
  for (const name of depNames) {
    const manifestPath = join(rootDir, "node_modules", name, "package.json");
    let pkg;
    try {
      pkg = readJson(manifestPath);
    } catch (err) {
      // Not a silent skip: a declared dependency with no installed
      // package.json means `npm ci` has not run, and quietly emitting a map
      // that is missing a plugin would boot a server without it.
      throw new Error(
        `cannot read ${manifestPath} for dependency "${name}" — run \`npm ci\` first (${err.message})`,
      );
    }
    if (pkg.gl3?.plugin === true) found.push({ packageName: name, identifier: toIdentifier(name) });
  }

  const byIdentifier = new Map();
  for (const entry of found) {
    const clash = byIdentifier.get(entry.identifier);
    if (clash !== undefined) {
      throw new Error(
        `package names "${clash}" and "${entry.packageName}" both map to the identifier ` +
          `"${entry.identifier}" — rename one, or the generated file will not compile`,
      );
    }
    byIdentifier.set(entry.identifier, entry.packageName);
  }
  return found;
}

/** Renders the generated module. Imports and one array — no logic lives here. */
export function renderPluginMap(entries) {
  const imports = entries.map((e) => `import ${e.identifier} from "${e.packageName}";`);
  const rows = entries.map((e) => `  ["${e.packageName}", ${e.identifier}],`);
  return [
    HEADER,
    `import type { PluginManifest } from "@gl3/plugin-sdk";`,
    ...imports,
    ``,
    `export const INSTALLED_PLUGINS: readonly (readonly [string, PluginManifest])[] = [`,
    ...rows,
    `];`,
    ``,
  ].join("\n");
}

function main(argv) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outPath = join(rootDir, OUTPUT_PATH);
  const rendered = renderPluginMap(discoverPlugins(rootDir));

  if (argv.includes("--check")) {
    let current = null;
    try {
      current = readFileSync(outPath, "utf8");
    } catch {
      current = null;
    }
    if (current !== rendered) {
      console.error(`${OUTPUT_PATH} is stale — run \`npm run plugins:generate\` and commit the result`);
      return 1;
    }
    return 0;
  }

  writeFileSync(outPath, rendered);
  return 0;
}

// Only when run as a program, so the test can import the functions above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
