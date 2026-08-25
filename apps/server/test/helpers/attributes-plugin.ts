import { definePlugin, type PluginManifest } from "@gl3/plugin-sdk";

/**
 * The attribute-model equivalent of `faro.ts`: a plugin that exists only so
 * the suite has something declaring a pool. Installed alongside CORE_PLUGINS
 * via `bootTestServer({ plugins: [attributesTestPlugin] })`.
 *
 * Small numbers on purpose — `defaultMax: 10` with one point a minute means a
 * test can drain the pool in a couple of spends and assert on exact figures.
 */
export const attributesTestPlugin: PluginManifest = definePlugin({
  id: "attrtest",
  version: "1.0.0",
  basePaths: ["/api/attrtest"],
  providesAttributes: [
    { pool: "energy", defaultMax: 10, regenAmount: 1, regenIntervalSeconds: 60 },
  ],
});
