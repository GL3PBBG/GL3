import { fileURLToPath } from "node:url";
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  {
    test: {
      name: "@gl3/server",
      root: "./apps/server",
      // Run once per test file (Vitest re-executes setupFiles per file even
      // when it reuses a worker process — see the files themselves for why
      // this exists): gives each file its own migrated Postgres database
      // (test/helpers/isolated-db.setup.ts) and auto-clears the shared
      // register/login Redis rate-limit buckets before every test
      // (test/helpers/rate-limit-isolation.setup.ts). Together these let
      // Vitest's default parallel file execution run safely — no test file
      // needs `--no-file-parallelism` or its own isolation workarounds.
      setupFiles: [
        "./test/helpers/isolated-db.setup.ts",
        "./test/helpers/rate-limit-isolation.setup.ts",
      ],
    },
    // Resolve @gl3/shared to its TypeScript source, not packages/shared/dist —
    // dist is a build artifact that can go stale relative to src (it only
    // rebuilds via `tsc --build`, which `npx vitest` never triggers), so
    // resolving to dist here would let a stale build pass tests with a false
    // green. Runtime (apps/server/src/index.ts, the built server) is
    // unaffected: this alias only applies inside this vitest project.
    resolve: {
      alias: {
        "@gl3/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      },
    },
  },
]);
