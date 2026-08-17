import type { PluginManifest, PropertyTypeDecl } from "@gl3/plugin-sdk";

/**
 * Every declared property type, keyed by id. Pure — recomputed at each call
 * site rather than cached, the same shape as `collectFilters` in `routes.ts`.
 *
 * A duplicate id is a hard boot failure. `definePlugin` already forces a
 * declaration's id to equal its plugin's id, so a collision here means two
 * manifests share an id; the guard stays anyway so this function is correct
 * standalone rather than only in the order the loader happens to run checks.
 */
export function collectPropertyTypes(
  manifests: readonly PluginManifest[],
): Map<string, PropertyTypeDecl> {
  const registry = new Map<string, PropertyTypeDecl>();
  for (const manifest of manifests) {
    for (const decl of manifest.providesProperties) {
      if (registry.has(decl.id)) {
        throw new Error(
          `plugin validation failed — property type "${decl.id}" is declared by more than one plugin`,
        );
      }
      registry.set(decl.id, decl);
    }
  }
  return registry;
}
