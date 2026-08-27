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
import mccodesAttributesPlugin from "@gl3/plugin-mccodes-attributes";
import gymPlugin from "@gl3/plugin-gym";
import housesPlugin from "@gl3/plugin-houses";
import educationPlugin from "@gl3/plugin-education";
import jobsPlugin from "@gl3/plugin-jobs";
import templePlugin from "@gl3/plugin-temple";
import progressionPlugin from "@gl3/plugin-progression";
import type { Gl3Profile } from "./manifest-endpoint.js";

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

/**
 * The MCCodes-parity family. mccodes-attributes first — it is the root of
 * every `requires` edge in the set (gym/houses/education/jobs/temple/
 * progression all require it).
 */
export const MCCODES_PLUGINS: readonly PluginManifest[] = [
  mccodesAttributesPlugin, gymPlugin, housesPlugin, educationPlugin,
  jobsPlugin, templePlugin, progressionPlugin,
];

/**
 * The v2 merge, in load order: framework first, then gameplay. The name
 * predates the four-mode split and the test suite leans on it as "the
 * historical full game"; it deliberately does NOT include the MCCodes
 * family — the gl3 union is built in `bundledPlugins`.
 */
export const CORE_PLUGINS: readonly PluginManifest[] = [...FRAMEWORK_PLUGINS, ...GAMEPLAY_PLUGINS];

/**
 * The boot set for a profile (spec 2026-08-27-gl3-hybrid-profile-design §1):
 * framework always; `v2` adds the gameplay set; `mccodes` adds the family
 * plus the shared gameplay plugins its mechanics live in (crimes, combat,
 * travel — inventory is already framework); `gl3` is the deduped union of
 * everything. The caller's optional manifests stack on top, de-duplicated
 * by id so a plugin named both here and among the optional manifests
 * doesn't load twice.
 */
export function bundledPlugins(
  profile: Gl3Profile,
  optional: readonly PluginManifest[],
): PluginManifest[] {
  const base =
    profile === "framework" ? FRAMEWORK_PLUGINS
    : profile === "v2" ? CORE_PLUGINS
    : profile === "mccodes"
      // detectives rides along because combat requires it (the underground
      // combat-mode reader) — not because MCCodes had detectives.
      ? [...FRAMEWORK_PLUGINS, ...MCCODES_PLUGINS, crimesPlugin, combatPlugin, travelPlugin, detectivesPlugin]
      : [...FRAMEWORK_PLUGINS, ...GAMEPLAY_PLUGINS, ...MCCODES_PLUGINS];
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
  return bundledPlugins("v2", optional);
}
