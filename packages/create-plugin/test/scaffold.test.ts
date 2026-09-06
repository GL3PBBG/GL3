import { describe, expect, it } from "vitest";
import { GENERATED_FILES, isValidPluginId, loadTemplates, render } from "../src/scaffold.js";

const templates = loadTemplates();
const files = render(templates, { id: "probe", sdkRange: "^9.9.9" });
const byPath = new Map(files.map((f) => [f.path, f.content]));

describe("isValidPluginId", () => {
  it("accepts lowercase kebab ids of 2–32 chars", () => {
    for (const ok of ["ab", "probe", "probe-two", "a1-b2"]) expect(isValidPluginId(ok)).toBe(true);
  });
  it("rejects everything else", () => {
    for (const bad of ["", "a", "Probe", "probe_1", "1probe", "-probe", "probe-", "a".repeat(33), "probe two"]) {
      expect(isValidPluginId(bad)).toBe(false);
    }
  });
});

describe("render", () => {
  it("renames the dotfile templates", () => {
    expect(byPath.has(".npmrc")).toBe(true);
    expect(byPath.has(".gitignore")).toBe(true);
    expect(byPath.has("_npmrc")).toBe(false);
    expect(byPath.has("_gitignore")).toBe(false);
  });

  it("emits exactly GENERATED_FILES, sorted", () => {
    expect(files.map((f) => f.path)).toEqual([...GENERATED_FILES]);
  });

  it("leaves no token behind", () => {
    for (const f of files) expect(f.content, f.path).not.toMatch(/__[A-Z_]+__/);
  });

  it("writes a market-shaped package.json for @gl3-plugins/<id>", () => {
    const pkg = JSON.parse(byPath.get("package.json") ?? "{}") as Record<string, unknown>;
    expect(pkg["name"]).toBe("@gl3-plugins/probe");
    expect(pkg["version"]).toBe("0.1.0");
    expect(pkg["type"]).toBe("module");
    expect(pkg["files"]).toEqual(["dist"]);
    expect(pkg["gl3"]).toEqual({ plugin: true });
    expect(pkg["publishConfig"]).toEqual({ registry: "https://npm.gl3.dev" });
    expect((pkg["scripts"] as Record<string, string>)["prepack"]).toBe("tsc --build");
    expect((pkg["peerDependencies"] as Record<string, string>)["@gl3/plugin-sdk"]).toBe("^9.9.9");
    expect((pkg["devDependencies"] as Record<string, string>)["@gl3/plugin-sdk"]).toBe("^9.9.9");
    const deps = pkg["dependencies"] as Record<string, string>;
    expect(Object.keys(deps).sort()).toEqual(["drizzle-orm", "zod"]);
    expect(pkg["dependencies"]).not.toHaveProperty("@gl3/plugin-sdk");
  });

  it("writes a scoped-only .npmrc", () => {
    const lines = (byPath.get(".npmrc") ?? "").trim().split("\n");
    expect(lines).toEqual([
      "@gl3:registry=https://npm.gl3.dev",
      "@gl3-plugins:registry=https://npm.gl3.dev",
    ]);
  });

  it("names the id in the README and the e2e checklist", () => {
    expect(byPath.get("README.md")).toContain("@gl3-plugins/probe");
    expect(byPath.get("README.md")).toContain("gl3_probe_test");
    expect(byPath.get("scripts/e2e-dynamic.md")).toContain("PLUGIN_PACKAGES=@gl3-plugins/probe");
  });

  it("is pure: same inputs, same output", () => {
    expect(render(templates, { id: "probe", sdkRange: "^9.9.9" })).toEqual(files);
  });
});
