import { definePlugin } from "@gl3/plugin-sdk";
import { MIGRATIONS } from "./migrations.js";

/**
 * The manifest is the ONLY wiring. A route, page, event or table you write
 * and do not list here does not exist — no error, no page.
 *
 * Fields (the schema is `.strict()`; an unknown key throws at import):
 *   id version apiVersion basePaths tables migrations routes pages adminPages
 *   events jobs provides filters providesAssets providesProperties
 *
 * - Every route path AND every view action path (`table.source`, `form.action`,
 *   `optionsSource`, `rowActions[].action`) must sit under a basePath.
 * - Routes under /api/admin/<id>/ must declare `auth: "admin"`.
 * - `version` must equal package.json's — test/manifest.test.ts checks.
 */
export default definePlugin({
  id: "__ID__",
  version: "0.1.0",
  apiVersion: 1,
  basePaths: ["/api/__ID__", "/api/admin/__ID__"],
  tables: {},
  migrations: MIGRATIONS,
  routes: [],
  pages: [],
  adminPages: [],
  events: [],
});
