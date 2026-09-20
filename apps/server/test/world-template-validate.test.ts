import { describe, expect, it } from "vitest";
import { DISTRICT_CORNER_V1 } from "../src/world/templates/district-corner-v1.js";
import { SCENE_TEMPLATES } from "../src/world/templates/index.js";
import { validateTemplate } from "../src/world/templates/validate.js";

describe("district-corner-v1", () => {
  it("is registered and passes every invariant", () => {
    expect(SCENE_TEMPLATES.get("district-corner-v1")).toBe(DISTRICT_CORNER_V1);
    expect(validateTemplate(DISTRICT_CORNER_V1)).toEqual([]);
  });
  it("has the spec's counts and the vehicle zone on one side", () => {
    const t = DISTRICT_CORNER_V1;
    const by = (k: string, z?: string) => t.slots.filter((s) => s.accepts === k && (z === undefined || s.zone === z));
    expect(by("building").length).toBe(25);
    expect(by("building", "vehicle").length).toBe(5);
    expect(by("npc").length).toBe(6);
    expect(by("prop", "parking").length).toBe(6);
    expect(new Set(by("building", "vehicle").map((s) => s.position.x)).size).toBe(1);
    expect(t.facilities.jail.yard).toEqual({ x: -115, y: 15 });
    expect(t.facilities.hospital.yard).toEqual({ x: -115, y: -15 });
  });
});

describe("validateTemplate", () => {
  const base = DISTRICT_CORNER_V1;
  it("names an out-of-bounds slot", () => {
    const t = { ...base, slots: [...base.slots, { id: "far", accepts: "building" as const, zone: "main", position: { x: 500, y: 15 }, facing: Math.PI, max: { w: 12, d: 9 } }] };
    expect(validateTemplate(t).some((m) => m.includes("far") && m.includes("bounds"))).toBe(true);
  });
  it("names two overlapping slots", () => {
    const dup = { ...base.slots[0]!, id: "dup" };
    expect(validateTemplate({ ...base, slots: [...base.slots, dup] }).some((m) => m.includes("dup") && m.includes("overlap"))).toBe(true);
  });
  it("names a building in the road band and a duplicate id", () => {
    const onRoad = { id: "onroad", accepts: "building" as const, zone: "main", position: { x: -100, y: 0 }, facing: 0, max: { w: 12, d: 9 } };
    const msgs = validateTemplate({ ...base, slots: [...base.slots, onRoad, { ...base.slots[1]!, position: { x: 400, y: 400 } }] });
    expect(msgs.some((m) => m.includes("onroad") && m.includes("road"))).toBe(true);
    expect(msgs.some((m) => m.includes("duplicate"))).toBe(true);
  });
  it("names a spawn inside a slot", () => {
    expect(validateTemplate({ ...base, spawn: { x: -30, y: -15, facing: 0 } }).some((m) => m.includes("spawn"))).toBe(true);
  });
});
