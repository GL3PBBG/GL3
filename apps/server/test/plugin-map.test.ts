import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildAvailablePlugins } from "../src/plugins/available.js";
import {
  OUTPUT_PATH,
  discoverPlugins,
  renderPluginMap,
  toIdentifier,
} from "../../../scripts/generate-plugin-map.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Builds a synthetic repo root: an `apps/server/package.json` declaring
 * `deps`, plus a `node_modules/` holding `installed`. Keeping the two lists
 * independent is the point — a package can be installed without being a direct
 * dependency (transitive) or declared without being installed (no `npm ci`).
 */
function makeRoot(deps: Record<string, string>, installed: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "gl3-plugin-map-"));
  mkdirSync(join(root, "apps/server"), { recursive: true });
  writeFileSync(
    join(root, "apps/server/package.json"),
    JSON.stringify({ name: "@gl3/server", dependencies: deps }),
  );
  for (const [name, pkg] of Object.entries(installed)) {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  }
  return root;
}

const marked = (name: string) => ({ name, gl3: { plugin: true } });
const unmarked = (name: string) => ({ name });

describe("discoverPlugins", () => {
  it("includes only marked direct dependencies, sorted by package name", () => {
    const root = makeRoot(
      { "@acme/zebra": "*", "@acme/alpha": "*", "@acme/plain": "*" },
      {
        "@acme/zebra": marked("@acme/zebra"),
        "@acme/alpha": marked("@acme/alpha"),
        "@acme/plain": unmarked("@acme/plain"),
        // Installed and marked, but nobody declared it: a transitive
        // dependency must never smuggle itself into the boot.
        "@acme/transitive": marked("@acme/transitive"),
      },
    );

    expect(discoverPlugins(root)).toEqual([
      { packageName: "@acme/alpha", identifier: "plugin_acme_alpha" },
      { packageName: "@acme/zebra", identifier: "plugin_acme_zebra" },
    ]);
  });

  it("throws naming the package when a declared dependency is not installed", () => {
    const root = makeRoot({ "@acme/ghost": "*" }, {});
    expect(() => discoverPlugins(root)).toThrow(/@acme\/ghost.*npm ci/s);
  });

  it("throws when two package names collapse to the same identifier", () => {
    const root = makeRoot(
      { "@acme/one-two": "*", "@acme/one.two": "*" },
      { "@acme/one-two": marked("@acme/one-two"), "@acme/one.two": marked("@acme/one.two") },
    );
    expect(() => discoverPlugins(root)).toThrow(/@acme\/one-two.*@acme\/one\.two/s);
  });
});

describe("toIdentifier", () => {
  it("produces a readable, valid JS identifier", () => {
    expect(toIdentifier("@gl3/hello-plugin")).toBe("plugin_gl3_hello_plugin");
    expect(toIdentifier("casino")).toBe("plugin_casino");
  });
});

describe("buildAvailablePlugins", () => {
  it("keys by manifest id, not package name", () => {
    const manifest = definePlugin({ id: "casino", version: "1.0.0", basePaths: ["/api/casino"] });
    const available = buildAvailablePlugins([["@acme/gl3-casino", manifest]]);
    expect(Object.keys(available)).toEqual(["casino"]);
    expect(available["casino"]).toBe(manifest);
  });

  it("throws naming both packages when two declare the same id", () => {
    const a = definePlugin({ id: "casino", version: "1.0.0", basePaths: ["/api/casino"] });
    const b = definePlugin({ id: "casino", version: "2.0.0", basePaths: ["/api/casino2"] });
    expect(() =>
      buildAvailablePlugins([
        ["@acme/casino", a],
        ["@rival/casino", b],
      ]),
    ).toThrow(/@acme\/casino.*@rival\/casino/s);
  });
});

describe("the committed plugin map", () => {
  // The whole reason the generated file is committed rather than built on the
  // fly. This runs in `@gl3/server:unit`, which needs no DB or Redis and so
  // runs in `verify:ci` — CI catches an operator who added the dependency and
  // forgot the regenerate.
  it("matches what the generator produces from the real dependency list", () => {
    const expected = renderPluginMap(discoverPlugins(REPO_ROOT));
    const committed = readFileSync(join(REPO_ROOT, OUTPUT_PATH), "utf8");
    expect(committed).toBe(expected);
  });
});
