import type { AssetSlot, PageSchema, ViewNode } from "@gl3/plugin-sdk";
import { CORE_SCOPE } from "../plugins/asset-slots.js";

/**
 * Core's art section, built FROM THE REGISTRY rather than hand-written.
 *
 * The hand-written version shipped three binders and no way to add a fourth
 * without editing this file — which is how `location` and `rank` ended up
 * bindable with nothing rendering them. Deriving the page means a slot that
 * exists is a slot an admin can fill, with no second list to keep in step.
 *
 * Every slot in the game appears here, core and plugin alike:
 *
 *  - a SINGLETON needs no picker, so it always renders;
 *  - a PER-ROW slot renders when it declares `entitySource`, which is what
 *    lets a plugin with no admin page of its own (`gangs`, `oc`) still have
 *    bindable row art.
 *
 * A per-row slot with no source is skipped rather than drawn dead: that plugin
 * is binding it from its own admin section, and a widget with an empty picker
 * would be a control that cannot work.
 *
 * Binding still checks `hasPermission(scope)` per slot, so a mixed-scope
 * section is safe: an admin holding only `travel` sees every widget and can
 * successfully use exactly the ones they are entitled to.
 */
export function buildAssetsPage(slots: Iterable<AssetSlot>): PageSchema {
  const perRow: ViewNode[] = [];
  const singletons: ViewNode[] = [];

  for (const slot of [...slots].sort(byScopeThenLabel)) {
    const title = slot.scope === CORE_SCOPE ? slot.label : `${slot.label} (${slot.scope})`;

    if (slot.singleton === true) {
      singletons.push({
        kind: "panel",
        title,
        children: [{ kind: "assetBinder", slot: slot.slot, scope: slot.scope }],
      });
      continue;
    }

    if (slot.entitySource === undefined || slot.entityLabelKey === undefined) continue;
    perRow.push({
      kind: "panel",
      title,
      children: [{
        kind: "assetBinder", slot: slot.slot, scope: slot.scope,
        entitySource: slot.entitySource, entityLabelKey: slot.entityLabelKey,
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
        { kind: "panel", title: "Page and feature art", children: singletons },
      ],
    },
  };
}

/** Core's own slots first, then plugins alphabetically — a stable, readable order. */
function byScopeThenLabel(a: AssetSlot, b: AssetSlot): number {
  if (a.scope !== b.scope) {
    if (a.scope === CORE_SCOPE) return -1;
    if (b.scope === CORE_SCOPE) return 1;
    return a.scope.localeCompare(b.scope);
  }
  return a.label.localeCompare(b.label);
}
