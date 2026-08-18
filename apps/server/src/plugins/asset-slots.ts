import type { AssetSlot, PluginManifest, ViewNode } from "@gl3/plugin-sdk";

export const CORE_SCOPE = "core";

/**
 * Slots for the core-owned tables plugins read but do not own. `inventory`
 * cannot declare art for `items` because `items` is not its table — several
 * plugins read it, and whichever declared it would arbitrarily own everyone
 * else's art. Core declares them once, under its own scope.
 */
export const CORE_ASSET_SLOTS: readonly AssetSlot[] = [
  // Per-row: one image for every row of a core-owned table.
  { scope: CORE_SCOPE, slot: "item", label: "Item image" },
  { scope: CORE_SCOPE, slot: "location", label: "Town image" },
  { scope: CORE_SCOPE, slot: "rank", label: "Rank badge" },
  { scope: CORE_SCOPE, slot: "crime", label: "Crime image" },

  // Singletons: one banner per page. These live under `core` rather than under
  // the plugin that owns each feature because the PAGES are hand-written in
  // `apps/web` — there is no manifest page to hang a `slotImage` on. A
  // marketplace plugin that ships its own page declares its own singleton and
  // puts a `slotImage` node in its view; both paths end at the same table.
  { scope: CORE_SCOPE, slot: "page-crimes", label: "Crimes page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-jail", label: "Jail page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-hospital", label: "Hospital page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-bank", label: "Bank page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-casino", label: "Casino page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-combat", label: "Combat page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-bounties", label: "Bounties page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-detectives", label: "Detectives page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-oc", label: "Organized crime page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-properties", label: "Properties page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-garage", label: "Garage page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-theft", label: "Car theft page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-gang", label: "Gang page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-mail", label: "Mail page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-news", label: "News page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-shop", label: "Shop page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-bullets", label: "Bullet shop banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-travel", label: "Travel page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-ranks", label: "Ranks page banner", singleton: true },
  { scope: CORE_SCOPE, slot: "page-leaderboards", label: "Leaderboards page banner", singleton: true },
];

export function slotKey(scope: string, slot: string): string {
  return `${scope}:${slot}`;
}

/**
 * Every declared slot, keyed `<scope>:<slot>`. Pure and recomputed per call
 * site, the same shape as `collectPropertyTypes`.
 *
 * `scope` is taken from the manifest's own id and is never author-supplied,
 * which is the difference from `PropertyTypeDecl` — that one carries an `id`
 * the author writes and `definePlugin` must check equals the plugin's own.
 * Here the field does not exist to get wrong, so two plugins cannot collide on
 * a slot name and no collision pass is needed. A plugin declaring the same slot
 * twice is the only conflict possible, and that is a boot failure.
 */
/**
 * Stamp every `assetBinder` in a view with the declaring plugin's id, and
 * return the rewritten view.
 *
 * Unconditional overwrite, not a default: `scope` decides whose art a widget
 * may rebind, so an author-supplied value must not survive. That is the only
 * thing standing between "a plugin declares an admin page" and "a plugin
 * declares an admin page that rebinds core's item art".
 *
 * Returns a new tree rather than mutating: manifests are shared across boots in
 * tests, and a mutating pass would leave the second boot's nodes already
 * stamped by the first.
 */
export function stampAssetBinderScope(view: ViewNode, scope: string): ViewNode {
  if (view.kind === "assetBinder" || view.kind === "slotImage") return { ...view, scope };
  if (view.kind === "panel") {
    return { ...view, children: view.children.map((child) => stampAssetBinderScope(child, scope)) };
  }
  if (view.kind === "list") {
    return { ...view, items: view.items.map((item) => stampAssetBinderScope(item, scope)) };
  }
  return view;
}

/** True if the view contains an `assetBinder` anywhere. Player pages may not. */
export function containsAssetBinder(view: ViewNode): boolean {
  if (view.kind === "assetBinder") return true;
  if (view.kind === "panel") return view.children.some(containsAssetBinder);
  if (view.kind === "list") return view.items.some(containsAssetBinder);
  return false;
}

export function collectAssetSlots(manifests: readonly PluginManifest[]): Map<string, AssetSlot> {
  const registry = new Map<string, AssetSlot>();
  for (const slot of CORE_ASSET_SLOTS) registry.set(slotKey(slot.scope, slot.slot), slot);
  for (const manifest of manifests) {
    for (const decl of manifest.providesAssets) {
      const key = slotKey(manifest.id, decl.slot);
      if (registry.has(key)) {
        throw new Error(
          `plugin validation failed — asset slot "${decl.slot}" is declared more than once by plugin "${manifest.id}"`,
        );
      }
      // Spread, not a field-by-field copy: rebuilding the declaration by hand
      // is what silently dropped `singleton` and made every plugin banner
      // unbindable, with the registry reporting the slot as per-entity.
      registry.set(key, { ...decl, scope: manifest.id });
    }
  }
  return registry;
}
