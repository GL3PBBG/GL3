import type { WorldHook } from "@gl3/plugin-sdk";
import type { Footprint, SceneBounds, SceneSpawn } from "@gl3/shared";

/** Core-owned jail/hospital hooks (spec 2026-09-18 §1): synthetic core pages, no plugin manifest, appended after every plugin hook. */
export const CORE_HOOKS: readonly WorldHook[] = [
  { pluginId: "core", id: "jail", kind: "building", label: "Jail", page: "jail", model: "jail", footprint: { w: 12, d: 9 }, order: Number.MAX_SAFE_INTEGER },
  { pluginId: "core", id: "hospital", kind: "building", label: "Hospital", page: "hospital", model: "hospital", footprint: { w: 12, d: 9 }, order: Number.MAX_SAFE_INTEGER },
];

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
  defaultFootprint: { building: { w: 12, d: 9 }, npc: { w: 1, d: 1 } } as const satisfies Record<"building" | "npc", Footprint>,
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
    if (hook.kind === "prop") continue; // props exist only in template bays (spec 2026-09-20 §2)
    const footprint: Footprint = hook.footprint ?? (hook.kind === "npc" ? LAYOUT.defaultFootprint.npc : LAYOUT.defaultFootprint.building);
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

/**
 * The street's walkable extent once the layout is known (2026-09-21): the
 * row's or default bounds, widened ALONG X so every placed building and every
 * core yard is inside with `LAYOUT.margin` to spare. Never shrinks a bound and
 * never touches y: the layout's y extents are fixed by `buildingLine + d/2`
 * (±15 for 12×9) and the default ±20 already holds them, while a row's y
 * bounds are the operator's own. Pure, so every client agrees.
 */
export function envelopeBounds(bounds: SceneBounds, placed: readonly PlacedGeometry[], core: readonly PlacedCore[]): SceneBounds {
  const x0s: number[] = [];
  const x1s: number[] = [];
  for (const g of placed) {
    x0s.push(g.position.x - g.footprint.w / 2);
    x1s.push(g.position.x + g.footprint.w / 2);
  }
  for (const g of core) {
    x0s.push(g.position.x - g.footprint.w / 2, g.yard.x - 3);
    x1s.push(g.position.x + g.footprint.w / 2, g.yard.x + 3);
  }
  const minX = x0s.length === 0 ? bounds.minX : Math.min(bounds.minX, Math.min(...x0s) - LAYOUT.margin);
  const maxX = x1s.length === 0 ? bounds.maxX : Math.max(bounds.maxX, Math.max(...x1s) + LAYOUT.margin);
  return { minX, minY: bounds.minY, maxX, maxY: bounds.maxY };
}

export interface PlacedCore extends PlacedGeometry {
  yard: { x: number; y: number };
}

/**
 * Pins jail (north) and hospital (south) to the east end of the street
 * (spec 2026-09-18 §1). Pure, deterministic: given the same already-placed
 * plugin geometry and bounds, every client agrees where they stand.
 *
 * Each starts at `bounds.maxX - 16` on its side and slides east past any
 * already-placed BUILDING on the same side whose footprint overlaps the
 * `[x - 6, x + 6]` slot, repeating until clear — the same rule the Godot
 * client used to invent itself. The yard is the building's east-adjacent
 * centre, `(x + 9, y)`.
 */
export function placeCoreHooks(placed: readonly PlacedGeometry[], bounds: SceneBounds): PlacedCore[] {
  const place = (hook: WorldHook, side: Side): PlacedCore => {
    // Derived from the entry's own declaration, never restated: editing a
    // CORE_HOOKS footprint has to move the building and its yard with it.
    const footprint: Footprint = hook.footprint ?? (hook.kind === "npc" ? LAYOUT.defaultFootprint.npc : LAYOUT.defaultFootprint.building);
    const half = footprint.w / 2;
    const d = footprint.d;
    let x = bounds.maxX - 16;
    const sameSide = placed.filter((p) => p.hook.kind === "building" && Math.sign(p.position.y) === side);
    for (;;) {
      const other = sameSide.find((p) => p.position.x + p.footprint.w / 2 > x - half && p.position.x - p.footprint.w / 2 < x + half);
      if (!other) break;
      x = other.position.x + other.footprint.w / 2 + 4 + half;
    }
    const y = side * (LAYOUT.buildingLine + d / 2);
    // The yard is the building's east-adjacent lot, same width as the gap
    // rule leaves it: its near edge is `x + half`, its centre `x + half + 3`.
    return { hook, footprint, position: { x, y }, facing: facingToward(side), yard: { x: x + half + 3, y } };
  };
  return [place(CORE_HOOKS[0]!, 1), place(CORE_HOOKS[1]!, -1)];
}
