import type { WorldHook } from "@gl3/plugin-sdk";
import type { Footprint, SceneBounds, SceneSpawn } from "@gl3/shared";

/**
 * Street geometry the Godot client's `default` city is built around (spec
 * 2026-09-17 §A). One straight street along x at y = 0: road |y| ≤ 7.5,
 * pavement to |y| = 10.5, buildings beyond the building line. All metres.
 */
export const LAYOUT = {
  margin: 4,
  gap: 4,
  buildingLine: 10.5,
  npcLine: 7.5,
  /** The spawn's own lot stays free of buildings: `[spawn.x - west, spawn.x + east]` on the spawn's side. */
  spawnLot: { west: 8, east: 10 },
  defaultFootprint: { building: { w: 12, d: 9 }, npc: { w: 1, d: 1 } } as const satisfies Record<WorldHook["kind"], Footprint>,
} as const;

export interface PlacedGeometry {
  hook: WorldHook;
  footprint: Footprint;
  /** Footprint centre. */
  position: { x: number; y: number };
  /** Godot yaw: 0 faces north (+y). North-side hooks face π (south, toward the street); south-side face 0. */
  facing: number;
}

type Side = 1 | -1;
const facingToward = (side: Side): number => (side === 1 ? Math.PI : 0);

/**
 * Deterministic auto-layout (spec §2.3, constants from §A, spawn-lot rule
 * from §B.2). Pure: same input → same output, on every boot and every
 * instance, which is what lets every client agree where the garage is.
 *
 * `hooks` must already be in layout order — `collectWorldHooks` sorts by
 * `(order, pluginId, id)` — and the output keeps that order.
 *
 * Buildings walk east from `minX + margin`, alternating north/south (north
 * first), each consuming `w + gap` of street. A building whose span would
 * cover the spawn lot on the spawn's side is placed on the opposite side,
 * and alternation resumes from the side actually used. NPCs consume no
 * street: each stands on the pavement in front of the building placed
 * just before it (or at the start of the street, north side, if none).
 * Overflow past `maxX` is served as computed — the client clamps players,
 * not buildings — so a street that runs out of room is visible, not hidden.
 */
export function placeHooks(hooks: readonly WorldHook[], bounds: SceneBounds, spawn: SceneSpawn): PlacedGeometry[] {
  const out: PlacedGeometry[] = [];
  let cursor = bounds.minX + LAYOUT.margin;
  let nextSide: Side = 1;
  let lastBuilding: { x: number; side: Side } | null = null;
  const spawnSide: Side = spawn.y < 0 ? -1 : 1;
  const lotMin = spawn.x - LAYOUT.spawnLot.west;
  const lotMax = spawn.x + LAYOUT.spawnLot.east;

  for (const hook of hooks) {
    const footprint: Footprint = hook.footprint ?? LAYOUT.defaultFootprint[hook.kind];
    if (hook.kind === "building") {
      let side = nextSide;
      const coversLot = cursor < lotMax && cursor + footprint.w > lotMin;
      if (side === spawnSide && coversLot) side = (-side) as Side;
      const x = cursor + footprint.w / 2;
      const y = side * (LAYOUT.buildingLine + footprint.d / 2);
      out.push({ hook, footprint, position: { x, y }, facing: facingToward(side) });
      lastBuilding = { x, side };
      cursor += footprint.w + LAYOUT.gap;
      nextSide = (-side) as Side;
    } else {
      const side: Side = lastBuilding?.side ?? 1;
      const x = lastBuilding?.x ?? bounds.minX + LAYOUT.margin;
      out.push({ hook, footprint, position: { x, y: side * LAYOUT.npcLine }, facing: facingToward(side) });
    }
  }
  return out;
}
