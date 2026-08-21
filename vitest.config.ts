import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 6,
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
