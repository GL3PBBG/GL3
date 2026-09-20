import type { SceneTemplate, Slot } from "@gl3/shared";

const N = Math.PI, S = 0, W = Math.PI / 2, E = -Math.PI / 2;
const B = { w: 12, d: 9 };
const b = (id: string, zone: string, x: number, y: number, facing: number): Slot => ({ id, accepts: "building", zone, position: { x, y }, facing, max: B });
const n = (id: string, x: number, y: number, facing: number): Slot => ({ id, accepts: "npc", zone: "main", position: { x, y }, facing, max: { w: 1, d: 1 } });
const p = (id: string, y: number): Slot => ({ id, accepts: "prop", zone: "parking", position: { x: 37, y }, facing: E, max: { w: 4, d: 2 } });

/**
 * Spec 2026-09-20 §7. Every number here is the contract the Godot corner scene is built to.
 * Geometry corrected 2026-09-20 after the validator caught two defects in the first draft: the
 * vehicle-street rows start at y = 18 (their 12 m side runs along y), the eighth north slot is
 * gone and an eighth south slot sits at (50, -15). Touching edges pass (`overlaps` is strict).
 */
export const DISTRICT_CORNER_V1: SceneTemplate = {
  key: "district-corner-v1",
  bounds: { minX: -120, minY: -20, maxX: 70, maxY: 100 },
  spawn: { x: 0, y: -15, facing: 0 },
  roads: [
    { from: { x: -120, y: 0 }, to: { x: 53.5, y: 0 }, halfWidth: 7.5, pavement: 3 },
    { from: { x: 46, y: 0 }, to: { x: 46, y: 100 }, halfWidth: 7.5, pavement: 3 },
  ],
  slots: [
    ...[-90, -74, -58, -42, -26, -10, 6].map((x, i) => b(`main-n-${i + 1}`, "main", x, 15, N)),
    ...[-90, -74, -58, -42, -26, 18, 34, 50].map((x, i) => b(`main-s-${i + 1}`, "main", x, -15, S)),
    ...[18, 34, 50, 66, 82].map((y, i) => b(`veh-e-${i + 1}`, "vehicle", 61, y, W)),
    ...[18, 34, 50, 66, 82].map((y, i) => b(`veh-w-${i + 1}`, "main", 31, y, E)),
    n("npc-1", -90, 7.5, N), n("npc-2", -58, 7.5, N), n("npc-3", 6, 7.5, N),
    n("npc-4", -42, -7.5, S), n("npc-5", 18, -7.5, S), n("npc-6", 38.5, 32, E),
    ...[12, 26, 40, 54, 68, 82].map((y, i) => p(`bay-${i + 1}`, y)),
  ],
  facilities: {
    jail: { ...b("jail", "core", -106, 15, N), yard: { x: -115, y: 15 } },
    hospital: { ...b("hospital", "core", -106, -15, S), yard: { x: -115, y: -15 } },
  },
};
