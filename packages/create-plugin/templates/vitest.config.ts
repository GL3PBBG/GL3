import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false, // one shared test database
    testTimeout: 20_000,
  },
});
