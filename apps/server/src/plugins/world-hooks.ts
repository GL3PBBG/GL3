import type { PluginManifest, WorldHook } from "@gl3/plugin-sdk";

/**
 * Every declared world hook, stamped with its owner and in layout order.
 * Pure and recomputed per call site, the same shape as `collectPropertyTypes`.
 *
 * The order is the whole contract: `placeHooks` walks this list east along
 * the street, so `(order, pluginId, id)` is what makes the layout identical
 * on every boot and every client. Intra-plugin uniqueness and the page /
 * signage cross-checks live in `validatePlugins`, which runs first.
 */
export function collectWorldHooks(manifests: readonly PluginManifest[]): WorldHook[] {
  const hooks: WorldHook[] = [];
  for (const manifest of manifests) {
    for (const decl of manifest.worldHooks) hooks.push({ ...decl, pluginId: manifest.id });
  }
  return hooks.sort(
    (a, b) => a.order - b.order || a.pluginId.localeCompare(b.pluginId) || a.id.localeCompare(b.id),
  );
}
