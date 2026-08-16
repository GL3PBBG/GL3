#!/usr/bin/env node
// Run only the tests reachable from what this branch changed.
//
// `vitest related` walks the module graph: it runs a test file when that file
// (transitively) imports one of the changed modules. That is the whole gear —
// and its whole blind spot. A guard that asserts against the DATABASE rather
// than against an import is invisible to it: `apps/server/test/schema.test.ts`
// counts foreign keys and indexes out of `pg_catalog` and imports nothing from
// the migration that changes them, so a new migration never lands in its
// related set. The rounds cluster proved this the expensive way — twelve green
// task-scoped runs, then two drift guards failed on the first full run.
//
// Use this while iterating. Before merging, run the bare `npm run verify`.
import { execFileSync, spawnSync } from "node:child_process";

const base = process.argv[2] ?? "main";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let mergeBase;
try {
  mergeBase = git(["merge-base", base, "HEAD"]);
} catch {
  console.error(`verify-related: cannot find a merge base with "${base}" — pass a ref, e.g. npm run verify:related -- origin/main`);
  process.exit(1);
}

// Committed changes since the merge base, plus anything dirty in the worktree.
const changed = [
  ...git(["diff", "--name-only", mergeBase, "HEAD"]).split("\n"),
  ...git(["diff", "--name-only", "HEAD"]).split("\n"),
  ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
]
  .filter((f) => f.length > 0)
  .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));

const files = [...new Set(changed)];
if (files.length === 0) {
  console.log("verify-related: no changed TypeScript files — nothing to run.");
  process.exit(0);
}

console.log(`verify-related: ${files.length} changed file(s) since ${mergeBase.slice(0, 7)}`);
const result = spawnSync("npx", ["vitest", "related", "--run", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
