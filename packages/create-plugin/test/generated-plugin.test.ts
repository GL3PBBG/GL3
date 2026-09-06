import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTemplates, render } from "../src/scaffold.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SDK_DIST = join(REPO, "packages/plugin-sdk/dist/index.d.ts");
const TSC = join(REPO, "node_modules/.bin/tsc");

/**
 * The template tree is the one place in this repo that is TypeScript but
 * lives outside every tsconfig `include` (its package.json carries tokens).
 * This test IS its typecheck: render a plugin with a hyphenated id, link the
 * WORKSPACE SDK into it the way `npm install` would, build it with the
 * generated tsconfig, then load the emitted manifest through real node
 * resolution — no vitest alias — and check the SDK's own parser accepted it.
 */
describe("a rendered plugin", () => {
  let dir = "";

  beforeAll(() => {
    if (!existsSync(SDK_DIST)) {
      throw new Error(`${SDK_DIST} is missing — run \`npm run build -w @gl3/plugin-sdk\` first`);
    }
    dir = mkdtempSync(join(tmpdir(), "gl3-create-plugin-"));
    for (const f of render(loadTemplates(), { id: "probe-two", sdkRange: "^0.0.0" })) {
      const abs = join(dir, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    mkdirSync(join(dir, "node_modules/@gl3"), { recursive: true });
    mkdirSync(join(dir, "node_modules/@types"), { recursive: true });
    symlinkSync(join(REPO, "packages/plugin-sdk"), join(dir, "node_modules/@gl3/plugin-sdk"), "dir");
    for (const dep of ["drizzle-orm", "zod"]) {
      symlinkSync(join(REPO, "node_modules", dep), join(dir, "node_modules", dep), "dir");
    }
    symlinkSync(join(REPO, "node_modules/@types/node"), join(dir, "node_modules/@types/node"), "dir");
  });

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("typechecks and builds with the generated tsconfig", () => {
    const out = execFileSync(TSC, ["--build", "--force"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    expect(out).toBe("");
    expect(existsSync(join(dir, "dist/index.js"))).toBe(true);
    expect(existsSync(join(dir, "dist/index.d.ts"))).toBe(true);
  });

  it("exports a manifest the SDK's own parser accepts", async () => {
    const mod = (await import(pathToFileURL(join(dir, "dist/index.js")).href)) as { default: unknown };
    const sdk = (await import(pathToFileURL(join(REPO, "packages/plugin-sdk/dist/index.js")).href)) as {
      parsePluginManifest: (input: unknown) => { id: string; apiVersion: number; basePaths: string[] };
    };
    const manifest = sdk.parsePluginManifest(mod.default);
    expect(manifest.id).toBe("probe-two");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.basePaths).toEqual(["/api/probe-two", "/api/admin/probe-two"]);
  });
});
