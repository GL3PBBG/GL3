import { definePlugin } from "@gl3/plugin-sdk";

// Re-exported from the manifest module rather than through an `exports`
// subpath: no other plugin has one, and the resolver is the only part of
// combat worth importing from outside (its tests run in the no-DB
// `@gl3/server:unit` project because it touches neither Postgres nor Redis).
export { resolveShot, rollFor } from "./resolve.js";
export type { Rolls, ShotOutcome, WeaponProfile } from "./resolve.js";
export { readCombatSettings } from "./settings.js";
export type { CombatSettings } from "./settings.js";

export default definePlugin({
  id: "combat",
  version: "1.0.0",
  basePaths: ["/api/combat"],
  // Deliberately empty for one commit — Task 10 adds the attack route.
  // `manifest.ts:98` types `routes` optional and `:168` defaults it to `[]`,
  // so the loader accepts this rather than rejecting a routeless plugin.
  routes: [],
});
