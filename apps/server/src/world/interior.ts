import type { CombatMode, InteriorDecl, RoomDescriptor, SceneBounds, SceneSpawn } from "@gl3/shared";

const inside = (b: SceneBounds, p: { x: number; y: number }): boolean =>
  p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

/**
 * Boot rules for a door's interior (spec 2026-09-20 casino-interior §3). Pure;
 * every violation is a sentence and an empty list is a valid floor. `exit` is
 * deliberately unchecked — it is a STREET coordinate, and the street's bounds
 * are not known here.
 */
export function validateInterior(decl: InteriorDecl): string[] {
  const out: string[] = [];
  if (!inside(decl.bounds, decl.spawn)) out.push("spawn lies outside bounds");
  const ids = new Set<string>();
  const bindings = new Set<string>();
  const stations = new Map<string, number[]>();
  for (const p of decl.points) {
    if (ids.has(p.id)) out.push(`point "${p.id}" is a duplicate id`);
    ids.add(p.id);
    if (!inside(decl.bounds, p.position)) out.push(`point "${p.id}" lies outside bounds`);
    (p.seats ?? []).forEach((s, i) => { if (!inside(decl.bounds, s)) out.push(`point "${p.id}" seat ${i} lies outside bounds`); });
    if (p.binding !== undefined) {
      const key = `${p.binding.gameId}/${p.binding.station}`;
      if (bindings.has(key)) out.push(`binding ${key} is declared twice`);
      bindings.add(key);
      const list = stations.get(p.binding.gameId) ?? [];
      list.push(p.binding.station);
      stations.set(p.binding.gameId, list);
    }
  }
  for (const [gameId, list] of stations) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    if (sorted.some((s, i) => s !== i)) out.push(`stations for "${gameId}" must be 0..n-1 without gaps`);
  }
  return out;
}

/** Unit vector for a Godot yaw: 0 = north (+y), positive counter-clockwise from above. */
const dir = (facing: number): { x: number; y: number } => ({ x: -Math.sin(facing), y: Math.cos(facing) });

/**
 * Where an exiting player stands (spec 2026-09-20 casino-interior §4.2): 3 m
 * beyond the door face, on the door's own facing, so they face away from the
 * building. `footprint.d` is always the depth ALONG the facing, whichever way
 * the slot turns. Clamped to the street, as every position is.
 */
export function exitSpotFor(
  placed: { position: { x: number; y: number }; facing: number; footprint: { w: number; d: number } },
  bounds: SceneBounds,
): SceneSpawn {
  const d = dir(placed.facing);
  const reach = placed.footprint.d / 2 + 3;
  const x = placed.position.x + d.x * reach;
  const y = placed.position.y + d.y * reach;
  // Kills float noise from sin(π) and, via `+ 0`, the -0 it can round to.
  const round = (n: number): number => Math.round(n * 1000) / 1000 + 0;
  return {
    x: round(Math.min(bounds.maxX, Math.max(bounds.minX, x))),
    y: round(Math.min(bounds.maxY, Math.max(bounds.minY, y))),
    facing: placed.facing,
  };
}

/** The room descriptor of one interior (spec §4.1): the town's identity, the floor's geometry. */
export function interiorDescriptor(
  town: { locationId: string; locationName: string; combatMode: CombatMode },
  hookRef: string,
  decl: InteriorDecl,
  exit: SceneSpawn,
): RoomDescriptor {
  return {
    locationId: town.locationId,
    locationName: town.locationName,
    combatMode: town.combatMode,
    sceneKey: decl.sceneKey,
    bounds: decl.bounds,
    spawn: decl.spawn,
    hooks: [],
    space: { kind: "interior", locationId: town.locationId, hookId: hookRef, exit },
    points: decl.points,
  };
}
