import type { PluginManifest } from "@gl3/plugin-sdk";
import bankPlugin from "@gl3/plugin-bank";
import bountiesPlugin from "@gl3/plugin-bounties";
import detectivesPlugin from "@gl3/plugin-detectives";
import forumPlugin from "@gl3/plugin-forum";
import ocPlugin from "@gl3/plugin-oc";
import bulletsPlugin from "@gl3/plugin-bullets";
import newsPlugin from "@gl3/plugin-news";
import notificationsPlugin from "@gl3/plugin-notifications";
import rankPlugin from "@gl3/plugin-ranks";
import travelPlugin from "@gl3/plugin-travel";
import crimesPlugin from "@gl3/plugin-crimes";
import mailPlugin from "@gl3/plugin-mail";
import membershipPlugin from "@gl3/plugin-membership";
import gangsPlugin from "@gl3/plugin-gangs";
import inventoryPlugin from "@gl3/plugin-inventory";
import combatPlugin from "@gl3/plugin-combat";
import theftPlugin from "@gl3/plugin-theft";
import propertiesPlugin from "@gl3/plugin-properties";
import casinoPlugin from "@gl3/plugin-casino";
import blackjackPlugin from "@gl3/plugin-blackjack";

/**
 * Ported core modules, split by what kind of game they assume. A static
 * `import` per manifest, not a lookup by id: that is what keeps the
 * dependency direction checkable by the compiler (spec). What changed with
 * the profile split is only *membership at runtime* — which of the two
 * static arrays a boot concatenates — never how the manifests get here.
 */
export const FRAMEWORK_PLUGINS: readonly PluginManifest[] = [
  rankPlugin, notificationsPlugin, newsPlugin, bankPlugin, mailPlugin,
  forumPlugin, inventoryPlugin, membershipPlugin,
];

/**
 * The gangster game on top of the framework. Loaded by the `full` profile;
 * individually addable onto a `framework` boot via `PLUGIN_IDS` (each of
 * these carries the `"gl3": { "plugin": true }` marker, so the generated
 * map makes them selectable). Cross-plugin requirements are declared on the
 * manifests (`requires`) and enforced at boot — see `plugins/validate.ts`.
 */
export const GAMEPLAY_PLUGINS: readonly PluginManifest[] = [
  bulletsPlugin, travelPlugin, crimesPlugin, gangsPlugin, combatPlugin, bountiesPlugin,
  detectivesPlugin, ocPlugin, theftPlugin, propertiesPlugin, casinoPlugin, blackjackPlugin,
];

/** Every bundled plugin, in load order: framework first, then gameplay. */
export const CORE_PLUGINS: readonly PluginManifest[] = [...FRAMEWORK_PLUGINS, ...GAMEPLAY_PLUGINS];

/**
 * The boot set for a profile: the framework set always, the gameplay set
 * only under `full`, plus the caller's optional manifests on top.
 * De-duplicated by id so a plugin named both here and among the optional
 * manifests doesn't load twice.
 */
export function bundledPlugins(
  profile: "full" | "framework",
  optional: readonly PluginManifest[],
): PluginManifest[] {
  const base = profile === "full" ? CORE_PLUGINS : FRAMEWORK_PLUGINS;
  const seenIds = new Set(base.map((m) => m.id));
  return [
    ...base,
    ...optional.filter((m) => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    }),
  ];
}

/**
 * The `full`-profile merge — what every pre-profile caller meant by
 * "core plugins plus my extras". Kept because the test suite leans on it
 * heavily; production boots go through `bundledPlugins(config.profile, ...)`.
 */
export function withCorePlugins(optional: readonly PluginManifest[]): PluginManifest[] {
  return bundledPlugins("full", optional);
}
