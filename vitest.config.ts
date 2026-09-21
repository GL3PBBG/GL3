import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 10, up from the 6 set in the ~3.8 GB era (2026-08-20 raised the box to
    // 8 GB / 32 CPUs). Measured 2026-09-21 during a full gate at 6 workers:
    // 3 GB used of 7 GB total with ~3 GB available, ~80 min wall clock. Each
    // worker boots servers and Postgres clones, so the step is 6 → 10, not
    // an uncapped 32: an uncapped runner has frozen this WSL twice
    // (jest, 2026-09-04). Raise further only after a full `npm run verify`
    // at this value is read from the process exit code and its memory
    // high-water mark is recorded in docs/STATUS.md.
    maxWorkers: 10,
    minWorkers: 1,
    // hookTimeout deliberately does NOT live here: this root config's
    // `test` block is not merged into vitest.workspace.ts's per-project
    // configs (verified empirically — setting hookTimeout here alone still
    // produced "Hook timed out in 10000ms" failures for workspace
    // projects), unlike maxWorkers/minWorkers above, which are pool-level
    // options applied regardless of workspace mode. See vitest.workspace.ts
    // (dbHookTimeout) for the real fix and its evidence.
    coverage: {
      include: ["apps/*/src/**", "packages/*/src/**", "packages/plugins/*/src/**"],
      exclude: ["**/dist/**", "**/*.d.ts", "**/*.test.ts", "**/migrations.ts"],
    },
  },
});
