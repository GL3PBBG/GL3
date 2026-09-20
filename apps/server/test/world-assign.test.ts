import type { WorldHook } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { assignHooks } from "../src/world/assign.js";
import { DISTRICT_CORNER_V1 } from "../src/world/templates/district-corner-v1.js";

const h = (pluginId: string, id: string, kind: WorldHook["kind"], order: number, extra: Partial<WorldHook> = {}): WorldHook => ({
  pluginId, id, kind, order, label: id, page: `${pluginId}.index`, model: id,
  ...(kind === "building" ? { footprint: { w: 12, d: 9 } } : {}), ...(kind === "prop" ? { footprint: { w: 4, d: 2 } } : {}), ...extra,
});
const T = DISTRICT_CORNER_V1;
const at = (r: ReturnType<typeof assignHooks>, id: string) => r.placed.find((p) => p.hook.id === id)!;
const slot = (id: string) => T.slots.find((s) => s.id === id)!;

describe("assignHooks", () => {
  it("fills zone-matching slots first, in hook order, and takes the slot's facing", () => {
    const r = assignHooks(T, [h("motorpool", "garage", "building", 50, { zone: "vehicle" }), h("theft", "garage", "building", 55, { zone: "vehicle" })], false);
    expect(at(r, "garage").position).toEqual(slot("veh-e-1").position);
    expect(r.placed[1]!.position).toEqual(slot("veh-e-2").position);
    expect(r.placed[1]!.facing).toBe(Math.PI / 2);
    expect(r.dropped).toEqual([]);
  });
  it("falls back to any free building slot when the zone has none left, but never for a prop", () => {
    const six = [1, 2, 3, 4, 5, 6].map((i) => h("v", `v${i}`, "building", i, { zone: "vehicle" }));
    const r = assignHooks(T, six, false);
    expect(r.placed.slice(0, 5).map((p) => p.position.x)).toEqual([61, 61, 61, 61, 61]);
    expect(r.placed[5]!.position).toEqual(slot("main-n-1").position);
    const cars = [1, 2, 3, 4, 5, 6, 7].map((i) => h("theft", `car-${i}`, "prop", i, { zone: "parking" }));
    const c = assignHooks(T, cars, false);
    expect(c.placed.length).toBe(6);
    expect(c.dropped).toEqual([{ hook: cars[6], reason: "no_slot" }]);
  });
  it("skips a slot too small for the footprint and keeps the hook's own footprint", () => {
    const wide = h("x", "wide", "building", 1, { footprint: { w: 14, d: 9 } });
    const r = assignHooks(T, [wide, h("y", "ok", "building", 2)], false);
    expect(r.dropped.map((d) => d.hook.id)).toEqual(["wide"]);
    expect(at(r, "ok").footprint).toEqual({ w: 12, d: 9 });
    const small = assignHooks(T, [h("z", "kiosk", "building", 1, { footprint: { w: 6, d: 6 } })], false);
    expect(at(small, "kiosk").footprint).toEqual({ w: 6, d: 6 });
    expect(at(small, "kiosk").position).toEqual(slot("main-n-1").position);
  });
  it("places an npc on an npc spot and a hook with no zone on the first free slot", () => {
    const r = assignHooks(T, [h("crimes", "corner", "npc", 20), h("bank", "bank", "building", 30)], false);
    expect(at(r, "corner").position).toEqual(slot("npc-1").position);
    expect(at(r, "bank").position).toEqual(slot("main-n-1").position);
  });
  it("appends core jail then hospital on the facility slots with their yards, only when asked", () => {
    const r = assignHooks(T, [], true);
    expect(r.core.map((c) => c.hook.id)).toEqual(["jail", "hospital"]);
    expect(r.core[0]).toMatchObject({ position: { x: -106, y: 15 }, facing: Math.PI, yard: { x: -115, y: 15 } });
    expect(r.core[1]).toMatchObject({ position: { x: -106, y: -15 }, facing: 0, yard: { x: -115, y: -15 } });
    expect(assignHooks(T, [], false).core).toEqual([]);
  });
});
