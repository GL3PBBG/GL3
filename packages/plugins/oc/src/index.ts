import { definePlugin } from "@gl3/plugin-sdk";
import { OC_MIGRATIONS } from "./migrations.js";

export default definePlugin({
  id: "oc",
  version: "1.0.0",
  basePaths: ["/api/oc"],
  routes: [],
  migrations: OC_MIGRATIONS,
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }.
});
