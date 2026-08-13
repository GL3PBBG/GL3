import type { PluginManifest } from "@gl3/plugin-sdk";

/**
 * Turns the generated `INSTALLED_PLUGINS` list into the id→manifest lookup
 * `PLUGIN_IDS` resolves against.
 *
 * Keyed by `manifest.id`, not by package name: nothing should assert the two
 * are equal. A marketplace package is free to be `@acme/casino` while
 * declaring `id: "casino"`, and only the manifest's own id ever appears in
 * `PLUGIN_IDS`, route paths or table prefixes.
 *
 * The duplicate check is the reason this is a function and not an inline
 * `Object.fromEntries`. Two packages declaring the same id would otherwise
 * have one silently shadow the other here — before `validatePlugins` ever
 * sees the pair, since only the survivor reaches it.
 */
export function buildAvailablePlugins(
  installed: readonly (readonly [string, PluginManifest])[],
): Record<string, PluginManifest> {
  const byId: Record<string, PluginManifest> = {};
  const packageById = new Map<string, string>();

  for (const [packageName, manifest] of installed) {
    const clash = packageById.get(manifest.id);
    if (clash !== undefined) {
      throw new Error(
        `plugin id "${manifest.id}" is declared by both "${clash}" and "${packageName}" — ` +
          `uninstall one of them`,
      );
    }
    packageById.set(manifest.id, packageName);
    byId[manifest.id] = manifest;
  }

  return byId;
}
