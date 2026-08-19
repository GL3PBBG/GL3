import { definePlugin } from "@gl3/plugin-sdk";
import { MEMBERSHIP_MIGRATIONS } from "./migrations.js";
import { benefits } from "./api.js";

export { MEMBERSHIP_TIMER_KEY, benefits, isMember, membershipUntil, type BenefitDecl } from "./api.js";

export default definePlugin({
  id: "membership",
  version: "1.0.0",
  basePaths: ["/api/membership", "/api/admin/membership"],
  tables: { packages: "p_membership_packages" },
  migrations: MEMBERSHIP_MIGRATIONS,
  routes: [],
  // Documentation parity with casino's `provides: [games]`: nothing reads
  // `PluginManifest.provides` today, but this is the point a consumer
  // subscribes to via `on(benefits, ...)` to add display copy.
  provides: [benefits],
});
