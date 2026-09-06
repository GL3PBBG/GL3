import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATED_FILES } from "../src/scaffold.js";
import { parseCliArgs } from "../src/cli.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TSX = join(REPO, "node_modules/.bin/tsx");
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[], cwd: string) {
  return spawnSync(TSX, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

describe("parseCliArgs", () => {
  it("derives the default dir from the id", () => {
    expect(parseCliArgs(["probe"])).toEqual({ ok: true, opts: { id: "probe", dir: "gl3-plugin-probe", install: true, sdk: undefined } });
  });
  it("takes an explicit dir, --no-install and --sdk", () => {
    expect(parseCliArgs(["probe", "here", "--no-install", "--sdk", "^2.0.0"])).toEqual({
      ok: true, opts: { id: "probe", dir: "here", install: false, sdk: "^2.0.0" },
    });
  });
  it("refuses a missing or malformed id and unknown flags", () => {
    expect(parseCliArgs([]).ok).toBe(false);
    expect(parseCliArgs(["Probe_1"]).ok).toBe(false);
    expect(parseCliArgs(["probe", "--bogus"]).ok).toBe(false);
  });
});

describe("create-plugin (spawned)", () => {
  let cwd = "";
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "gl3-cli-")); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("exits 1 with usage and writes nothing on a bad id", () => {
    const res = run(["Probe_1", "--no-install"], cwd);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("lowercase");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("exits 1 and leaves a non-empty target untouched", () => {
    mkdirSync(join(cwd, "gl3-plugin-probe"));
    writeFileSync(join(cwd, "gl3-plugin-probe/keep.txt"), "mine");
    const res = run(["probe", "--no-install"], cwd);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("not an empty directory");
    expect(readdirSync(join(cwd, "gl3-plugin-probe"))).toEqual(["keep.txt"]);
  });

  it("writes the tree, inits git, skips install with --no-install, prints next steps", () => {
    const res = run(["probe", "--no-install", "--sdk", "^1.0.0"], cwd);
    expect(res.status, res.stderr).toBe(0);
    const dir = join(cwd, "gl3-plugin-probe");
    for (const p of GENERATED_FILES) expect(existsSync(join(dir, p)), p).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(res.stdout).toContain("Created @gl3-plugins/probe");
    expect(res.stdout).toContain("createdb gl3_probe_test");
    expect(res.stdout).toContain("PLUGIN_PACKAGES=@gl3-plugins/probe");
    expect(res.stderr).not.toContain("warning"); // --sdk given → no registry lookup, no fallback warning
  });

  it("honours an explicit target dir", () => {
    const res = run(["probe", "custom-dir", "--no-install", "--sdk", "^1.0.0"], cwd);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(cwd, "custom-dir/package.json"))).toBe(true);
  });

  it("runs main exactly once when invoked through the packaged bin", () => {
    execFileSync(join(REPO, "node_modules/.bin/tsc"), ["--build", "--force"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: "pipe",
    });
    const bin = fileURLToPath(new URL("../bin/create-plugin.js", import.meta.url));
    const res = spawnSync(process.execPath, [bin, "probe", "--no-install", "--sdk", "^1.0.0"], { cwd, encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    // A second invocation of main would hit the now-non-empty dir and exit 1, so a
    // single 0 plus a single next-steps banner is the proof of one run.
    expect(res.stdout.match(/Created @gl3-plugins\/probe/g)).toHaveLength(1);
    expect(existsSync(join(cwd, "gl3-plugin-probe/package.json"))).toBe(true);
  });
});
