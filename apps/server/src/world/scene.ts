import type { WorldHook } from "@gl3/plugin-sdk";
import {
  CombatModeSchema,
  DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_KEY, DEFAULT_SCENE_SPAWN,
  SceneBoundsSchema, SceneSpawnSchema,
  type PlacedHook, type RoomDescriptor, type SceneBounds, type SceneSpawn,
} from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { StorageDriver } from "../assets/driver.js";
import { resolveSingletonAsset } from "../assets/service.js";
import type { Db } from "../db/client.js";
import { locations, locationScenes } from "../db/schema/index.js";
import { placeCoreHooks, placeHooks, type PlacedCore, type PlacedGeometry } from "./layout.js";

export interface SceneService {
  /** The room descriptor for a town, or null when no such location exists. */
  forLocation(locationId: string): Promise<RoomDescriptor | null>;
}

export interface SceneServiceDeps {
  db: Db;
  assetDriver: StorageDriver;
  /** `LoadedPlugins.worldHooks` — boot-static, already in layout order. */
  hooks: readonly WorldHook[];
  /**
   * Whether to append the core jail and hospital hooks (spec 2026-09-18 §1).
   * `config.profile !== "framework"` at every call site: a framework boot
   * registers neither route nor page, so its scenes carry no core hooks.
   */
  coreHooks: boolean;
}

/**
 * Builds `RoomDescriptor`s (spec 2026-09-17 §1.4). Geometry is a boot-static
 * function of `(bounds, spawn)` and is memoised per distinct pair for the
 * process lifetime — hooks cannot change without a reboot. Signage is
 * resolved per request because an admin can bind an image at any time.
 *
 * Signage is resolved per hook, not batched (spec §B.10): N is the number
 * of hooks carrying a `signageSlot`, boot-static and tiny, and each one is
 * a different `(scope, slot)` pair that `resolveAssets` cannot batch anyway.
 */
export function createSceneService(deps: SceneServiceDeps): SceneService {
  /** Plugin geometry and the core placement derived from it share one cache entry. */
  interface Layout { placed: PlacedGeometry[]; core: PlacedCore[] }
  const layouts = new Map<string, Layout>();
  const layoutFor = (bounds: SceneBounds, spawn: SceneSpawn): Layout => {
    const key = JSON.stringify([bounds, spawn]);
    let layout = layouts.get(key);
    if (layout === undefined) {
      const placed = placeHooks(deps.hooks, bounds, spawn);
      const core = deps.coreHooks ? placeCoreHooks(placed, bounds) : [];
      // Overflow is served as computed, exactly as plugin-hook overflow is
      // (spec §1) — but it is worth saying once per distinct layout, which
      // is what this memo makes "once" mean. The test is the yard's east
      // EDGE, not its centre: the yard spans `x + 6 … x + 12` around a
      // centre of `x + 9`, so it has already run off the street three
      // metres before its centre does.
      for (const g of core) {
        if (g.yard.x + 3 > bounds.maxX) {
          console.warn(
            { hookId: g.hook.id, x: g.position.x, yardEastX: g.yard.x + 3, maxX: bounds.maxX },
            "world: core hook overflows the street",
          );
        }
      }
      layout = { placed, core };
      layouts.set(key, layout);
    }
    return layout;
  };

  return {
    async forLocation(locationId) {
      const [town] = await deps.db
        .select({ id: locations.id, name: locations.name, combatMode: locations.combatMode })
        .from(locations).where(eq(locations.id, locationId));
      if (!town) return null;

      const [row] = await deps.db.select().from(locationScenes).where(eq(locationScenes.locationId, locationId));
      // jsonb columns are validated on the way OUT: there is no writer yet,
      // and a hand-edited row must fail loudly here rather than as a client
      // that parses the snapshot and refuses to render.
      const bounds = row ? SceneBoundsSchema.parse(row.bounds) : DEFAULT_SCENE_BOUNDS;
      const spawn = row ? SceneSpawnSchema.parse(row.spawn) : DEFAULT_SCENE_SPAWN;
      const sceneKey = row?.sceneKey ?? DEFAULT_SCENE_KEY;

      // Concurrent, not sequential: spec §B.10 asks for one resolution per
      // hook, and each is an independent `(scope, slot)` pair. A hook whose
      // signage cannot be read renders unsigned rather than taking the whole
      // street down with it — the malformed-jsonb parse above deliberately
      // still throws, because a room the client cannot place is not a room.
      const { placed, core } = layoutFor(bounds, spawn);
      const signage = await Promise.all(placed.map(async ({ hook }) => {
        if (hook.signageSlot === undefined) return null;
        try {
          return await resolveSingletonAsset(deps.db, deps.assetDriver, hook.pluginId, hook.signageSlot);
        } catch (err) {
          console.error(
            { err, pluginId: hook.pluginId, slot: hook.signageSlot },
            "world: signage resolution failed",
          );
          return null;
        }
      }));

      const hooks: PlacedHook[] = placed.map((g, i) => ({
        id: `${g.hook.pluginId}.${g.hook.id}`,
        pluginId: g.hook.pluginId,
        hookId: g.hook.id,
        kind: g.hook.kind,
        label: g.hook.label,
        model: g.hook.model,
        footprint: g.footprint,
        position: g.position,
        facing: g.facing,
        href: `/plugins/${g.hook.page}`,
        signageUrl: signage[i] ?? null,
      }));

      // AFTER every plugin hook, in jail-then-hospital order (spec §1). Core
      // pages carry no signage slot and no plugin manifest, so `signageUrl`
      // is a constant null and `yard` is the one field only these two have.
      for (const g of core) {
        hooks.push({
          id: `${g.hook.pluginId}.${g.hook.id}`,
          pluginId: g.hook.pluginId,
          hookId: g.hook.id,
          kind: g.hook.kind,
          label: g.hook.label,
          model: g.hook.model,
          footprint: g.footprint,
          position: g.position,
          facing: g.facing,
          href: `/plugins/${g.hook.page}`,
          signageUrl: null,
          yard: g.yard,
        });
      }

      return {
        locationId: town.id,
        locationName: town.name,
        combatMode: CombatModeSchema.parse(town.combatMode),
        sceneKey,
        bounds,
        spawn,
        hooks,
      };
    },
  };
}
