import { fileURLToPath } from "node:url";
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  {
    test: { name: "@gl3/server", root: "./apps/server" },
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
