import { definePlugin } from "@gl3/plugin-sdk";
import { MEMBERSHIP_MIGRATIONS } from "./migrations.js";

export default definePlugin({
  id: "membership",
  version: "1.0.0",
  basePaths: ["/api/membership", "/api/admin/membership"],
  tables: { packages: "p_membership_packages" },
  migrations: MEMBERSHIP_MIGRATIONS,
  routes: [],
});
