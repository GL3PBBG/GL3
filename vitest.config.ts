import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 6,
    minWorkers: 1,
  },
});
