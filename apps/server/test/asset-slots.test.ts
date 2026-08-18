import { definePlugin } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  CORE_ASSET_SLOTS, collectAssetSlots, containsAssetBinder, slotKey, stampAssetBinderScope,
} from "../src/plugins/asset-slots.js";
import { validatePlugins } from "../src/plugins/validate.js";

const binder = { kind: "assetBinder", slot: "car", entitySource: "GET /api/admin/theft/cars", entityLabelKey: "name" } as const;

describe("collectAssetSlots", () => {
  it("registers core's own slots without any plugin", () => {
    const registry = collectAssetSlots([]);

    for (const slot of CORE_ASSET_SLOTS) {
      expect(registry.get(slotKey("core", slot.slot))).toEqual(slot);
    }
  });

  it("derives a plugin's scope from its own id rather than the declaration", () => {
    const plugin = definePlugin({
      id: "theft", version: "1.0.0", basePaths: ["/api/theft"],
      providesAssets: [{ slot: "car", label: "Car image" }],
    });

    const registry = collectAssetSlots([plugin]);

    // The declaration carries no `scope` field at all, which is what makes a
    // collision between two plugins impossible: each can only ever register
    // under its own id.
    expect(registry.get(slotKey("theft", "car"))).toEqual({ scope: "theft", slot: "car", label: "Car image" });
  });

  it("lets two plugins use the same slot name without colliding", () => {
    const a = definePlugin({
      id: "theft", version: "1.0.0", basePaths: ["/api/theft"],
      providesAssets: [{ slot: "car", label: "Car" }],
    });
    const b = definePlugin({
      id: "garageco", version: "1.0.0", basePaths: ["/api/garageco"],
      providesAssets: [{ slot: "car", label: "Also a car" }],
    });

    const registry = collectAssetSlots([a, b]);

    expect(registry.get(slotKey("theft", "car"))?.label).toBe("Car");
    expect(registry.get(slotKey("garageco", "car"))?.label).toBe("Also a car");
  });

  it("rejects a plugin declaring the same slot twice", () => {
    const plugin = definePlugin({
      id: "dupes", version: "1.0.0", basePaths: ["/api/dupes"],
      providesAssets: [{ slot: "car", label: "One" }, { slot: "car", label: "Two" }],
    });

    expect(() => collectAssetSlots([plugin])).toThrow(/declared more than once/);
  });
});

describe("stampAssetBinderScope", () => {
  it("overwrites an author-supplied scope rather than defaulting it", () => {
    // The overwrite is the security property: if an author-supplied `core`
    // survived, any plugin could ship an admin page that rebinds core's item
    // art, and the bind route's per-scope permission check would pass.
    const stamped = stampAssetBinderScope({ ...binder, scope: "core" }, "theft");

    expect(stamped).toMatchObject({ kind: "assetBinder", scope: "theft" });
  });

  it("reaches binders nested inside panels and lists", () => {
    const view = {
      kind: "panel", title: "Art",
      children: [{ kind: "list", items: [binder] }],
    } as const;

    const stamped = stampAssetBinderScope(view, "theft");

    const list = (stamped as { children: { items: { scope: string }[] }[] }).children[0];
    expect(list?.items[0]?.scope).toBe("theft");
  });

  it("returns a new tree rather than mutating the manifest's own nodes", () => {
    const view = { kind: "panel", title: "Art", children: [{ ...binder }] } as const;

    stampAssetBinderScope(view, "theft");

    // Manifests are module-level constants shared across every boot in a test
    // run; a mutating stamp would leave the second boot's nodes already carrying
    // the first boot's scope.
    expect((view.children[0] as { scope?: string }).scope).toBeUndefined();
  });

  it("leaves views with no binder untouched", () => {
    const view = { kind: "text", value: "nothing here" } as const;
    expect(stampAssetBinderScope(view, "theft")).toBe(view);
    expect(containsAssetBinder(view)).toBe(false);
  });
});

describe("boot validation", () => {
  it("rejects an assetBinder on a player-facing page", () => {
    const plugin = definePlugin({
      id: "leaky", version: "1.0.0", basePaths: ["/api/leaky", "/api/admin/leaky"],
      providesAssets: [{ slot: "car", label: "Car" }],
      pages: [{
        id: "leaky.page", path: "/leaky",
        view: { kind: "panel", title: "Cars", children: [
          { kind: "assetBinder", slot: "car", entitySource: "GET /api/leaky/cars", entityLabelKey: "name" },
        ] },
      }],
    });

    expect(() => validatePlugins([plugin])).toThrow(/valid only on an admin page/);
  });

  it("accepts the same binder on an admin page", () => {
    const plugin = definePlugin({
      id: "tidy", version: "1.0.0", basePaths: ["/api/tidy", "/api/admin/tidy"],
      providesAssets: [{ slot: "car", label: "Car" }],
      adminPages: [{
        id: "tidy.admin", path: "/admin/tidy",
        view: { kind: "panel", title: "Cars", children: [
          { kind: "assetBinder", slot: "car", entitySource: "GET /api/admin/tidy/cars", entityLabelKey: "name" },
        ] },
      }],
    });

    expect(() => validatePlugins([plugin])).not.toThrow();
  });

  it("holds an assetBinder's entitySource to the plugin's own basePaths", () => {
    const plugin = definePlugin({
      id: "reachy", version: "1.0.0", basePaths: ["/api/reachy", "/api/admin/reachy"],
      providesAssets: [{ slot: "car", label: "Car" }],
      adminPages: [{
        id: "reachy.admin", path: "/admin/reachy",
        view: {
          kind: "assetBinder", slot: "car",
          // Another plugin's admin list. The picker fetches on mount exactly
          // like a table source, so containment applies to it the same way.
          entitySource: "GET /api/admin/theft/cars", entityLabelKey: "name",
        },
      }],
    });

    expect(() => validatePlugins([plugin])).toThrow(/outside/);
  });
});
