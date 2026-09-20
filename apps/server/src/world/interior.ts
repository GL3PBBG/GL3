import type { InteriorDecl, SceneBounds } from "@gl3/shared";

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
