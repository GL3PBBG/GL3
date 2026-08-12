import { definePlugin } from "@gl3/plugin-sdk";

/**
 * V2's detectives module, GL3-shaped: the cross-location hunting layer.
 * Spec: the offline design note.
 * Uses core's `detective_searches` table (no plugin migrations); no combat
 * coupling; no events, menu or pages (plugin-manifest-endpoint.test.ts pins
 * the no-arg boot payload).
 */
export default definePlugin({
  id: "detectives",
  version: "1.0.0",
  basePaths: ["/api/detectives"],
  routes: [],
});
