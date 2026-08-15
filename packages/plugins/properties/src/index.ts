import { definePlugin } from "@gl3/plugin-sdk";
import { PROPERTIES_MIGRATIONS } from "./migrations.js";
import { readPropertiesSettings } from "./settings.js";

// Re-exported so tests can import the parser and types directly.
export { readPropertiesSettings, type PropertiesSettings } from "./settings.js";
export { accruedSince } from "./resolve.js";

/**
 * Stub manifest — routes, events, pages and adminPages arrive in later tasks.
 */
export default definePlugin({
  id: "properties",
  version: "1.0.0",
  basePaths: ["/api/properties", "/api/admin/properties"],
  tables: {
    properties: "p_properties_properties",
  },
  migrations: PROPERTIES_MIGRATIONS,
  routes: [],
  events: [],
  pages: [],
  adminPages: [],
});
