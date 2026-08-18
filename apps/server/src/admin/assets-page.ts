import type { AssetSlot, PageSchema, ViewNode } from "@gl3/plugin-sdk";
import { CORE_SCOPE } from "../plugins/asset-slots.js";

/**
 * Which core-owned table a per-row core slot picks from. Only core slots need
 * an entry: a plugin's own per-row slot is bound from that plugin's admin
 * section, where the plugin already has a list route to pick from.
 */
const CORE_ENTITY_SOURCE: Record<string, { source: string; labelKey: string; title: string }> = {
  item: { source: "GET /api/admin/assets/entities/items", labelKey: "name", title: "Items" },
  location: { source: "GET /api/admin/assets/entities/locations", labelKey: "name", title: "Towns" },
  rank: { source: "GET /api/admin/assets/entities/ranks", labelKey: "name", title: "Ranks" },
  crime: { source: "GET /api/admin/assets/entities/crimes", labelKey: "name", title: "Crimes" },
};

/**
 * Core's art section, built FROM THE REGISTRY rather than hand-written.
 *
 * The hand-written version shipped three binders and no way to add a fourth
 * without editing this file — which is how `location` and `rank` ended up
 * bindable with nothing rendering them, and how every page banner would have
 * ended up missing too. Deriving the page means a slot that exists is a slot an
 * admin can fill, with no second list to keep in step.
 *
 * Every SINGLETON slot in the game appears here, including plugins' own, so a
 * plugin gets an upload widget for its banner without shipping an admin page.
 * Per-row PLUGIN slots deliberately do not: binding those needs a list of that
 * plugin's rows, which only that plugin can serve, so they belong in its own
 * admin section (see `theft`'s "Car art" panel).
 *
 * Binding still checks `hasPermission(scope)` per slot, so a mixed-scope
 * section is safe: an admin holding only `travel` sees every widget and can
 * successfully use exactly the ones they are entitled to.
 */
export function buildAssetsPage(slots: Iterable<AssetSlot>): PageSchema {
  const perRow: ViewNode[] = [];
  const singletons: ViewNode[] = [];

  for (const slot of [...slots].sort((a, b) => a.label.localeCompare(b.label))) {
    if (slot.singleton === true) {
      singletons.push({
        kind: "panel",
        title: slot.scope === CORE_SCOPE ? slot.label : `${slot.label} (${slot.scope})`,
        children: [{ kind: "assetBinder", slot: slot.slot, scope: slot.scope }],
      });
      continue;
    }
    if (slot.scope !== CORE_SCOPE) continue;
    const source = CORE_ENTITY_SOURCE[slot.slot];
    // A core per-row slot with no picker would render a widget that cannot be
    // used. Skipping it is better than shipping a dead control; adding the
    // entry above is what enables it.
    if (source === undefined) continue;
    perRow.push({
      kind: "panel",
      title: source.title,
      children: [{
        kind: "assetBinder", slot: slot.slot, scope: slot.scope,
        entitySource: source.source, entityLabelKey: source.labelKey,
      }],
    });
  }

  return {
    id: "core-assets-admin",
    path: "/admin/assets",
    view: {
      kind: "panel",
      title: "Game art",
      children: [
        { kind: "text", value: "PNG, JPEG or WebP. Uploading the same file twice costs nothing — identical bytes are stored once." },
        { kind: "panel", title: "Content", children: perRow },
        { kind: "panel", title: "Page banners", children: singletons },
      ],
    },
  };
}
