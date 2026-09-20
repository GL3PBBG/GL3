import type { Road, SceneTemplate, Slot } from "@gl3/shared";
import { overlaps, slotRect, type Rect } from "./types.js";

/** A road's band as a rectangle. Callers only ever pass an axis-aligned road — `validateTemplate` checks that below and excludes any road that fails it from the band checks. */
function roadRect(road: Road, extra: number): Rect {
  const half = road.halfWidth + extra;
  return {
    x0: Math.min(road.from.x, road.to.x) - (road.from.y === road.to.y ? 0 : half),
    x1: Math.max(road.from.x, road.to.x) + (road.from.y === road.to.y ? 0 : half),
    y0: Math.min(road.from.y, road.to.y) - (road.from.x === road.to.x ? 0 : half),
    y1: Math.max(road.from.y, road.to.y) + (road.from.x === road.to.x ? 0 : half),
  };
}

const inside = (r: Rect, b: SceneTemplate["bounds"]): boolean => r.x0 >= b.minX && r.x1 <= b.maxX && r.y0 >= b.minY && r.y1 <= b.maxY;
const contains = (r: Rect, p: { x: number; y: number }): boolean => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1;

/**
 * Spec 2026-09-20 §4. Returns every violation as a sentence; an empty list is
 * a valid template. A template is a build artefact, so the boot fails on any
 * violation (`assertTemplatesValid`) — never on plugin count, which is §3's job.
 */
export function validateTemplate(t: SceneTemplate): string[] {
  const out: string[] = [];
  const all: Slot[] = [...t.slots, t.facilities.jail, t.facilities.hospital];
  const seen = new Set<string>();
  for (const s of all) {
    if (seen.has(s.id)) out.push(`slot "${s.id}" is a duplicate id`);
    seen.add(s.id);
    if (!inside(slotRect(s), t.bounds)) out.push(`slot "${s.id}" lies outside bounds`);
  }
  for (const f of [t.facilities.jail, t.facilities.hospital]) {
    if (f.accepts !== "building") out.push(`facility "${f.id}" must accept building`);
    const yard: Rect = { x0: f.yard.x - 3, x1: f.yard.x + 3, y0: f.yard.y - 3, y1: f.yard.y + 3 };
    if (!inside(yard, t.bounds)) out.push(`facility "${f.id}" yard lies outside bounds`);
  }
  for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < all.length; j += 1) {
    if (overlaps(slotRect(all[i]!), slotRect(all[j]!))) out.push(`slots "${all[i]!.id}" and "${all[j]!.id}" overlap`);
  }
  // A diagonal road's band is otherwise under-constrained (`roadRect` assumes
  // axis-alignment), which would let a diagonal road under-cover the npc
  // "stands on a pavement" rule below — so a diagonal road is reported here
  // and excluded from every band check that follows, rather than fed into them.
  const alignedRoads = t.roads.filter((road) => {
    if (road.from.x !== road.to.x && road.from.y !== road.to.y) {
      out.push(`road "${road.from.x},${road.from.y}→${road.to.x},${road.to.y}" is not axis-aligned`);
      return false;
    }
    return true;
  });
  for (const s of all) {
    const r = slotRect(s);
    if (s.accepts === "building") {
      if (alignedRoads.some((road) => overlaps(r, roadRect(road, road.pavement)))) out.push(`slot "${s.id}" intersects a road or pavement`);
    } else if (s.accepts === "prop") {
      if (alignedRoads.some((road) => overlaps(r, roadRect(road, 0)))) out.push(`slot "${s.id}" intersects a road`);
    } else if (!alignedRoads.some((road) => contains(roadRect(road, road.pavement), s.position))) {
      out.push(`npc slot "${s.id}" does not stand on a pavement`);
    }
  }
  const sb = t.bounds;
  if (!(t.spawn.x > sb.minX && t.spawn.x < sb.maxX && t.spawn.y > sb.minY && t.spawn.y < sb.maxY)) out.push("spawn lies outside bounds");
  for (const s of all) if (contains(slotRect(s), t.spawn)) out.push(`spawn lies inside slot "${s.id}"`);
  return out;
}
