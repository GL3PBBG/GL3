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
import { assignHooks } from "./assign.js";
import { exitSpotFor, interiorDescriptor } from "./interior.js";
import { envelopeBounds, placeCoreHooks, placeHooks, type PlacedCore, type PlacedGeometry } from "./layout.js";
import { SCENE_TEMPLATES } from "./templates/index.js";
import { eligibleHooks, venueKeys, venuesAt } from "./venues.js";

/** The answer to one interior lookup: the room, or why there is none. */
export type InteriorLookup =
  | { ok: true; room: RoomDescriptor }
  | { ok: false; code: "no_location" | "unknown_hook" | "no_interior" };

export interface SceneService {
  /** The room descriptor for a town, or null when no such location exists. */
  forLocation(locationId: string): Promise<RoomDescriptor | null>;
  /** One door's interior in one town (spec 2026-09-20 casino-interior §4.1). */
  forInterior(locationId: string, hookRef: string): Promise<InteriorLookup>;
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
  /**
   * Whether the `properties` plugin is loaded (spec 2026-09-21 town-venues
   * §3.1). Required rather than defaulted, the `coreHooks` discipline: a new
   * call site cannot inherit the wrong answer. False means no town holds any
   * venue — the table does not exist on such a boot, and a hook naming one is
   * already refused at boot there.
   */
  hasProperties: boolean;
}

/**
 * Builds `RoomDescriptor`s (spec 2026-09-17 §1.4). Geometry is a function of
 * `(sceneKey, bounds, spawn, eligible hooks)` and is memoised per distinct
 * combination for the process lifetime — the hook SET is boot-static, but
 * which of them a town is eligible for is not (spec 2026-09-21 §3.2), so two
 * towns sharing a template but not a venue get separate entries. Signage is
 * resolved per request because an admin can bind an image at any time.
 *
 * Signage is resolved per hook, not batched (spec §B.10): N is the number
 * of hooks carrying a `signageSlot`, boot-static and tiny, and each one is
 * a different `(scope, slot)` pair that `resolveAssets` cannot batch anyway.
 */
export function createSceneService(deps: SceneServiceDeps): SceneService {
  /** Boot-static: the hook set cannot change without a reboot, only which town is eligible for it. */
  const keys = venueKeys(deps.hooks);
  /** Plugin geometry, the core placement derived from it, and the SERVED bounds — a client walks the whole street, never the row's raw claim. */
  interface Layout { placed: PlacedGeometry[]; core: PlacedCore[]; bounds: SceneBounds }
  const layouts = new Map<string, Layout>();
  const layoutFor = (sceneKey: string, rowBounds: SceneBounds, spawn: SceneSpawn, hooks: readonly WorldHook[]): Layout => {
    // The eligible hook ids are part of the key, not just the scene: a town
    // without the casino's venue must not be served the layout built for a
    // town that has it (spec 2026-09-21 §3.2).
    const key = JSON.stringify([sceneKey, rowBounds, spawn, hooks.map((h) => `${h.pluginId}.${h.id}`)]);
    let layout = layouts.get(key);
    if (layout === undefined) {
      const template = SCENE_TEMPLATES.get(sceneKey);
      if (template !== undefined) {
        const { placed, core, dropped } = assignHooks(template, hooks, deps.coreHooks);
        // Once per distinct layout, like the widened-bounds notice below: a
        // dropped hook is a missing door, and a missing door is an
        // operator's problem to see, not a player's page to 500.
        for (const d of dropped) {
          console.error(
            { template: template.key, pluginId: d.hook.pluginId, hookId: d.hook.id, kind: d.hook.kind, zone: d.hook.zone ?? null, reason: d.reason },
            "world: hook dropped — no free slot",
          );
        }
        // Templates are validated to contain every slot they place (spec
        // 2026-09-20 §2), so the authored bounds are already the served ones.
        layout = { placed, core, bounds: template.bounds };
      } else {
        const placed = placeHooks(hooks, rowBounds, spawn);
        const core = deps.coreHooks ? placeCoreHooks(placed, rowBounds) : [];
        const bounds = envelopeBounds(rowBounds, placed, core);
        // Once per distinct layout: a widened street is an operator-visible
        // fact, not a player-visible one — there is no invisible wall to
        // report any more, only a street that grew to fit what stands on it.
        if (bounds.minX !== rowBounds.minX || bounds.maxX !== rowBounds.maxX) {
          console.info({ sceneKey, from: rowBounds, to: bounds }, "world: street bounds widened to fit the layout");
        }
        layout = { placed, core, bounds };
      }
      layouts.set(key, layout);
    }
    return layout;
  };

  /** Town identity plus the geometry of its scene — everything both readers below share. */
  interface Resolved {
    town: { id: string; name: string; combatMode: string };
    sceneKey: string;
    bounds: SceneBounds;
    spawn: SceneSpawn;
    placed: PlacedGeometry[];
    core: PlacedCore[];
  }
  const resolve = async (locationId: string): Promise<Resolved | null> => {
    const [town] = await deps.db
      .select({ id: locations.id, name: locations.name, combatMode: locations.combatMode })
      .from(locations).where(eq(locations.id, locationId));
    if (!town) return null;

    const [row] = await deps.db.select().from(locationScenes).where(eq(locationScenes.locationId, locationId));
    const sceneKey = row?.sceneKey ?? DEFAULT_SCENE_KEY;
    const template = SCENE_TEMPLATES.get(sceneKey);
    // jsonb columns are validated on the way OUT: there is no writer yet,
    // and a hand-edited row must fail loudly here rather than as a client
    // that parses the snapshot and refuses to render. A template's own
    // bounds/spawn win over the row (spec §3) — they are the authored
    // contract the client is built to, not an operator-editable field.
    const rowBounds = template?.bounds ?? (row ? SceneBoundsSchema.parse(row.bounds) : DEFAULT_SCENE_BOUNDS);
    const spawn = template?.spawn ?? (row ? SceneSpawnSchema.parse(row.spawn) : DEFAULT_SCENE_SPAWN);
    // A hook gated on a venue stands only where that town holds the property
    // row (spec 2026-09-21 §3.2). Filtered BEFORE placement, so the street a
    // town without the venue is served has no gap where the door would be —
    // and `forInterior` below reads the same `placed`, so an ineligible door
    // is `unknown_hook` for lookup and for `presence.enter` alike.
    const present = await venuesAt(deps.db, locationId, keys, deps.hasProperties);
    const hooks = eligibleHooks(deps.hooks, present);
    // Placement is keyed on the ROW bounds — no town's building positions
    // move — but everything downstream serves the layout's own `bounds`,
    // widened to contain what was actually placed on it (2026-09-21).
    const { placed, core, bounds } = layoutFor(sceneKey, rowBounds, spawn, hooks);
    return { town, sceneKey, bounds, spawn, placed, core };
  };

  return {
    async forLocation(locationId) {
      const resolved = await resolve(locationId);
      if (resolved === null) return null;
      const { town, sceneKey, bounds, spawn, placed, core } = resolved;

      // Concurrent, not sequential: spec §B.10 asks for one resolution per
      // hook, and each is an independent `(scope, slot)` pair. A hook whose
      // signage cannot be read renders unsigned rather than taking the whole
      // street down with it — the malformed-jsonb parse above deliberately
      // still throws, because a room the client cannot place is not a room.
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
        // A door the client may ENTER (spec 2026-09-20 casino-interior §4.1).
        // Only the key travels on the street; the floor itself is a separate
        // fetch, so a town of doors costs one descriptor, not N interiors.
        ...(g.hook.interior !== undefined ? { interior: { sceneKey: g.hook.interior.sceneKey } } : {}),
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
        space: { kind: "street", locationId: town.id },
      };
    },

    async forInterior(locationId, hookRef) {
      const r = await resolve(locationId);
      if (r === null) return { ok: false, code: "no_location" };
      // Core hooks live in `core`, not `placed`: search both so a core
      // building answers `no_interior` rather than pretending not to exist.
      // A hook the template DROPPED is in neither, so it reads `unknown_hook`.
      const g = [...r.placed, ...r.core].find((p) => `${p.hook.pluginId}.${p.hook.id}` === hookRef);
      if (g === undefined) return { ok: false, code: "unknown_hook" };
      if (g.hook.interior === undefined) return { ok: false, code: "no_interior" };
      const exit = g.hook.interior.exit ?? exitSpotFor(g, r.bounds);
      return {
        ok: true,
        room: interiorDescriptor(
          { locationId: r.town.id, locationName: r.town.name, combatMode: CombatModeSchema.parse(r.town.combatMode) },
          hookRef,
          g.hook.interior,
          exit,
        ),
      };
    },
  };
}
