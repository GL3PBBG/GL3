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
import { placeHooks, type PlacedGeometry } from "./layout.js";

export interface SceneService {
  /** The room descriptor for a town, or null when no such location exists. */
  forLocation(locationId: string): Promise<RoomDescriptor | null>;
}

export interface SceneServiceDeps {
  db: Db;
  assetDriver: StorageDriver;
  /** `LoadedPlugins.worldHooks` — boot-static, already in layout order. */
  hooks: readonly WorldHook[];
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
  const layouts = new Map<string, PlacedGeometry[]>();
  const layoutFor = (bounds: SceneBounds, spawn: SceneSpawn): PlacedGeometry[] => {
    const key = JSON.stringify([bounds, spawn]);
    let placed = layouts.get(key);
    if (placed === undefined) {
      placed = placeHooks(deps.hooks, bounds, spawn);
      layouts.set(key, placed);
    }
    return placed;
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

      const hooks: PlacedHook[] = [];
      for (const g of layoutFor(bounds, spawn)) {
        const signageUrl = g.hook.signageSlot === undefined
          ? null
          : await resolveSingletonAsset(deps.db, deps.assetDriver, g.hook.pluginId, g.hook.signageSlot);
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
          signageUrl,
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
