import type { WorldHook } from "@gl3/plugin-sdk";
import { DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { LAYOUT, placeHooks } from "../src/world/layout.js";

const hook = (pluginId: string, id: string, kind: "building" | "npc", order: number, footprint?: { w: number; d: number }): WorldHook => ({
  pluginId, id, kind, order, label: id, page: `${pluginId}.index`, model: kind === "npc" ? "npc-coat" : id,
  ...(footprint ? { footprint } : {}),
});

// Already in (order, pluginId, id) order, as collectWorldHooks guarantees.
const poc: WorldHook[] = [
  hook("travel", "station", "building", 10, { w: 12, d: 9 }),
  hook("crimes", "corner", "npc", 20),
  hook("bank", "bank", "building", 30, { w: 12, d: 9 }),
  hook("news", "newsstand", "building", 40, { w: 6, d: 6 }),
];

const rect = (p: { position: { x: number; y: number }; footprint: { w: number; d: number } }) => ({
  x0: p.position.x - p.footprint.w / 2, x1: p.position.x + p.footprint.w / 2,
  y0: p.position.y - p.footprint.d / 2, y1: p.position.y + p.footprint.d / 2,
});
const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe("placeHooks", () => {
  it("is deterministic and keeps input order", () => {
    const a = placeHooks(poc, DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN);
    const b = placeHooks(poc, DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN);
    expect(a).toEqual(b);
    expect(a.map((p) => p.hook.id)).toEqual(["station", "corner", "bank", "newsstand"]);
  });

  it("walks east from minX + margin, alternating sides, buildings beyond the building line facing the street", () => {
    const [station, , bank, newsstand] = placeHooks(poc, DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN);
    // First building: north, x from -36 to -24 → centre -30; y = 10.5 + 4.5.
    expect(station!.position).toEqual({ x: -30, y: 15 });
    expect(station!.facing).toBe(Math.PI);
    // Second building would be south at cursor -20 → span [-20, -8]: that
    // touches the spawn lot [-8, 10] only at the edge (-8 is not < -8), so it
    // stays south; y = -(10.5 + 4.5).
    expect(bank!.position).toEqual({ x: -14, y: -15 });
    expect(bank!.facing).toBe(0);
    // Third: north, cursor -4, w 6 → centre -1; y = 10.5 + 3.
    expect(newsstand!.position).toEqual({ x: -1, y: 13.5 });
  });

  it("stands an NPC on the pavement in front of the previous building, facing the street", () => {
    const [station, corner] = placeHooks(poc, DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN);
    expect(corner!.position).toEqual({ x: station!.position.x, y: LAYOUT.npcLine });
    expect(corner!.facing).toBe(Math.PI);
    expect(corner!.footprint).toEqual({ w: 1, d: 1 });
  });

  it("puts a first NPC with no building before it at the start of the street on the north side", () => {
    const [corner] = placeHooks([hook("crimes", "corner", "npc", 1)], DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN);
    expect(corner!.position).toEqual({ x: DEFAULT_SCENE_BOUNDS.minX + LAYOUT.margin, y: LAYOUT.npcLine });
  });

  it("keeps the spawn lot clear: a building that would cover it on the spawn side goes to the other side", () => {
    // Narrow bounds so the second building's span [cursor, cursor+w] covers the lot.
    const bounds = { minX: -20, minY: -20, maxX: 40, maxY: 20 };
    const hooks = [hook("a", "one", "building", 1, { w: 12, d: 9 }), hook("b", "two", "building", 2, { w: 12, d: 9 })];
    const [, two] = placeHooks(hooks, bounds, DEFAULT_SCENE_SPAWN);
    // cursor for `two` is -16 + 16 = 0 → span [0, 12] overlaps [-8, 10] → forced north.
    expect(two!.position.y).toBeGreaterThan(0);
    for (const p of placeHooks(hooks, bounds, DEFAULT_SCENE_SPAWN)) {
      const r = rect(p);
      const inside = DEFAULT_SCENE_SPAWN.x >= r.x0 && DEFAULT_SCENE_SPAWN.x <= r.x1
        && DEFAULT_SCENE_SPAWN.y >= r.y0 && DEFAULT_SCENE_SPAWN.y <= r.y1;
      expect(inside).toBe(false);
    }
  });

  it("never overlaps two footprints, for a long street of mixed sizes", () => {
    const many: WorldHook[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(hook("p", `b${String(i).padStart(2, "0")}`, "building", i, i % 3 === 0 ? { w: 6, d: 6 } : { w: 12, d: 9 }));
      if (i % 4 === 1) many.push(hook("p", `n${i}`, "npc", i));
    }
    many.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const placed = placeHooks(many, DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN);
    const rects = placed.map(rect);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!), `${placed[i]!.hook.id} vs ${placed[j]!.hook.id}`).toBe(false);
      }
    }
  });

  it("applies the default footprint when none is declared", () => {
    const [b, n] = placeHooks([hook("p", "b", "building", 1), hook("p", "n", "npc", 2)], DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN);
    expect(b!.footprint).toEqual({ w: 12, d: 9 });
    expect(n!.footprint).toEqual({ w: 1, d: 1 });
  });
});
