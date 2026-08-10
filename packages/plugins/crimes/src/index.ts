import { definePlugin } from "@gl3/plugin-sdk";

export default definePlugin({
  id: "crimes",
  version: "1.0.0",
  basePaths: ["/api/crimes"],
  routes: [],
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. The job is added in Task 3.
});
