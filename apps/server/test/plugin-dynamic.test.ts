import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDynamicPlugins } from "../src/plugins/dynamic.js";

/**
 * Real packages on real disk, really imported — the repo's no-mocks rule
 * applies here more than anywhere, because what is under test IS module
 * resolution. A mocked `import` would prove nothing about the thing that
 * actually breaks (an `exports` map Node refuses to resolve).
 */
function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "gl3-dynamic-"));
}

/**
 * Writes `<dir>/node_modules/<name>/` with the given package.json fields and
 * one module file. `entry` is the path the fields point at.
 */
function writePackage(
  dir: string,
  name: string,
  fields: Record<string, unknown>,
  entry: string,
  source: string,
): void {
  const packageDir = join(dir, "node_modules", name);
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", ...fields }),
  );
  writeFileSync(join(packageDir, entry), source);
}

/** A manifest as a plain object — no SDK import, which is the realistic case. */
const MANIFEST = `export default {
  id: "fixture",
  version: "2.0.0",
  basePaths: ["/api/fixture"],
};`;

describe("loadDynamicPlugins", () => {
  it("loads a package resolved out of the plugin directory", async () => {
    const dir = makeDir();
    writePackage(
      dir,
      "fixture-plugin",
      { main: "./dist/index.js", exports: { ".": { default: "./dist/index.js" } } },
      "dist/index.js",
      MANIFEST,
    );

    const loaded = await loadDynamicPlugins(["fixture-plugin"], dir);

    expect(loaded).toHaveLength(1);
    const [packageName, manifest] = loaded[0]!;
    expect(packageName).toBe("fixture-plugin");
    expect(manifest.id).toBe("fixture");
    expect(manifest.version).toBe("2.0.0");
    // The manifest above declares no apiVersion: an out-of-repo plugin
    // authored before the field existed defaults to the current contract.
    expect(manifest.apiVersion).toBe(1);
    // Normalised by parsePluginManifest — the caller never writes `?? []`.
    expect(manifest.routes).toEqual([]);
    expect(manifest.migrations).toEqual([]);
  });

  it("resolves a package whose exports map offers only `import`", async () => {
    // `require.resolve` answers ERR_PACKAGE_PATH_NOT_EXPORTED for this shape,
    // so it exercises the package.json fallback rather than the fast path. A
    // pure-ESM third-party plugin is entirely legitimate and must load.
    const dir = makeDir();
    writePackage(
      dir,
      "esm-only-plugin",
      { exports: { ".": { import: "./dist/index.js" } } },
      "dist/index.js",
      MANIFEST,
    );

    const loaded = await loadDynamicPlugins(["esm-only-plugin"], dir);

    expect(loaded[0]![1].id).toBe("fixture");
  });

  it("loads several packages and keeps their order", async () => {
    const dir = makeDir();
    for (const [name, id] of [["a-plugin", "alpha"], ["b-plugin", "beta"]]) {
      writePackage(
        dir,
        name!,
        { main: "./dist/index.js" },
        "dist/index.js",
        `export default { id: "${id}", version: "1.0.0", basePaths: ["/api/${id}"] };`,
      );
    }

    const loaded = await loadDynamicPlugins(["b-plugin", "a-plugin"], dir);

    expect(loaded.map(([, m]) => m.id)).toEqual(["beta", "alpha"]);
  });

  it("rejects a malformed manifest, naming the package and the field", async () => {
    const dir = makeDir();
    writePackage(
      dir,
      "broken-plugin",
      { main: "./dist/index.js" },
      "dist/index.js",
      // Uppercase id and a non-semver version: two separate schema failures.
      `export default { id: "Fixture", version: "two", basePaths: ["/api/fixture"] };`,
    );

    await expect(loadDynamicPlugins(["broken-plugin"], dir)).rejects.toThrow(
      /cannot load plugin package "broken-plugin".*lowercase kebab-case/s,
    );
  });

  it("rejects a plugin declaring an unsupported apiVersion, naming the contract", async () => {
    const dir = makeDir();
    writePackage(
      dir,
      "future-plugin",
      { main: "./dist/index.js" },
      "dist/index.js",
      // apiVersion 2 AND a v2-only field: the contract error must beat
      // `.strict()`'s "Unrecognized key", which is the entire point of the
      // check running before the schema — this is the 2026-08-24 stale-image
      // crash-loop shape, made to say something actionable instead.
      `export default { id: "future", version: "1.0.0", apiVersion: 2, category: "weapons", basePaths: ["/api/future"] };`,
    );

    await expect(loadDynamicPlugins(["future-plugin"], dir)).rejects.toThrow(
      /cannot load plugin package "future-plugin" — invalid plugin manifest for "future" — apiVersion: plugin declares 2 but this build of @gl3\/plugin-sdk implements 1/,
    );
  });

  it("rejects a package with no default export", async () => {
    const dir = makeDir();
    writePackage(
      dir,
      "no-default-plugin",
      { main: "./dist/index.js" },
      "dist/index.js",
      `export const manifest = { id: "fixture", version: "1.0.0", basePaths: ["/api/fixture"] };`,
    );

    await expect(loadDynamicPlugins(["no-default-plugin"], dir)).rejects.toThrow(
      /no default export/,
    );
  });

  it("rejects a specifier that is not installed in the directory", async () => {
    const dir = makeDir();

    await expect(loadDynamicPlugins(["absent-plugin"], dir)).rejects.toThrow(
      /cannot load plugin package "absent-plugin" — not resolvable from/,
    );
  });

  it("rejects a package whose entry point throws on import", async () => {
    const dir = makeDir();
    writePackage(
      dir,
      "throwing-plugin",
      { main: "./dist/index.js" },
      "dist/index.js",
      `throw new Error("boom at module scope");`,
    );

    await expect(loadDynamicPlugins(["throwing-plugin"], dir)).rejects.toThrow(
      /import failed \(boom at module scope\)/,
    );
  });

  it("is a no-op for an empty package list", async () => {
    expect(await loadDynamicPlugins([], null)).toEqual([]);
  });
});
