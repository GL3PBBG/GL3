import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RenderedFile } from "./scaffold.js";

/** Absent, or an existing empty directory. */
export function dirIsUsable(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return statSync(dir).isDirectory() && readdirSync(dir).length === 0;
}

export function writeFiles(dir: string, files: readonly RenderedFile[]): void {
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

/** `git init -b main`, no commit — the first commit is the author's. A missing git is a warning. */
export function gitInit(dir: string, warn: (message: string) => void): void {
  const res = spawnSync("git", ["init", "--initial-branch=main", "--quiet"], { cwd: dir, stdio: "ignore" });
  if (res.error || res.status !== 0) warn("warning: `git init` failed or git is not on PATH; the tree is still usable.");
}

/** `npm install` with output shown. Returns false on a non-zero exit. */
export function npmInstall(dir: string): boolean {
  const res = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
  return !res.error && res.status === 0;
}
