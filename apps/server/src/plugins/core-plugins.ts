import type { PluginManifest } from "@gl3/plugin-sdk";
import bankPlugin from "@gl3/plugin-bank";
import bountiesPlugin from "@gl3/plugin-bounties";
import detectivesPlugin from "@gl3/plugin-detectives";
import bulletsPlugin from "@gl3/plugin-bullets";
import newsPlugin from "@gl3/plugin-news";
import notificationsPlugin from "@gl3/plugin-notifications";
import rankPlugin from "@gl3/plugin-ranks";
import travelPlugin from "@gl3/plugin-travel";
import crimesPlugin from "@gl3/plugin-crimes";
import mailPlugin from "@gl3/plugin-mail";
import gangsPlugin from "@gl3/plugin-gangs";
import inventoryPlugin from "@gl3/plugin-inventory";
import combatPlugin from "@gl3/plugin-combat";

/**
 * Ported core modules — plugin-served, never optional. A static `import`
 * per manifest, not a lookup by id: that is what keeps the dependency
 * direction checkable by the compiler (spec) and is why this list, unlike
 * `PLUGIN_IDS`, cannot be driven by an env var.
 *
 * `apps/server/src/index.ts` loads this set unconditionally, concatenated
 * with whatever optional manifests `PLUGIN_IDS` selects. `buildApp` also
 * falls back to it whenever a caller builds an app without specifying
 * `deps.plugins` at all (see the comment at that seam in `app.ts`) — which
 * is how `apps/server/test/ranks.test.ts` gets `/api/ranks` from the
 * plugin route despite calling `buildApp` directly, with no test-boot
 * change of its own.
 */
export const CORE_PLUGINS: readonly PluginManifest[] = [
  rankPlugin, notificationsPlugin, newsPlugin, bankPlugin, bulletsPlugin, travelPlugin, crimesPlugin,
  mailPlugin, gangsPlugin, inventoryPlugin, combatPlugin, bountiesPlugin, detectivesPlugin,
];

/**
 * A ported core module is never optional (spec) — CORE_PLUGINS always loads,
 * and the caller's optional manifests only add to it. De-duplicated by id so
 * a core module's id also named among the optional manifests doesn't load
 * twice.
 */
export function withCorePlugins(optional: readonly PluginManifest[]): PluginManifest[] {
  const seenIds = new Set(CORE_PLUGINS.map((m) => m.id));
  return [
    ...CORE_PLUGINS,
    ...optional.filter((m) => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    }),
  ];
}
