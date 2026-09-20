import type { InteriorDecl } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { validateInterior } from "../src/world/interior.js";

const base: InteriorDecl = {
  sceneKey: "floor", bounds: { minX: -12, minY: -9, maxX: 12, maxY: 9 }, spawn: { x: 0, y: -7.5, facing: 0 },
  points: [
    { id: "t-1", kind: "table", label: "T1", model: "m", position: { x: -6, y: 3 }, facing: Math.PI, seats: [{ x: -6, y: 1, facing: 0 }], binding: { gameId: "bj", station: 0 } },
    { id: "t-2", kind: "table", label: "T2", model: "m", position: { x: 6, y: 3 }, facing: Math.PI, binding: { gameId: "bj", station: 1 } },
  ],
};

describe("validateInterior", () => {
  it("accepts a well-formed floor", () => { expect(validateInterior(base)).toEqual([]); });
  it("reports a spawn, a point and a seat outside bounds", () => {
    expect(validateInterior({ ...base, spawn: { x: 13, y: 0, facing: 0 } })).toContain("spawn lies outside bounds");
    expect(validateInterior({ ...base, points: [{ ...base.points[0]!, position: { x: 0, y: 10 } }] })).toContain('point "t-1" lies outside bounds');
    expect(validateInterior({ ...base, points: [{ ...base.points[0]!, seats: [{ x: 0, y: -9.5, facing: 0 }] }] })).toContain('point "t-1" seat 0 lies outside bounds');
  });
  it("reports duplicate point ids and duplicate bindings", () => {
    expect(validateInterior({ ...base, points: [base.points[0]!, { ...base.points[1]!, id: "t-1" }] })).toContain('point "t-1" is a duplicate id');
    expect(validateInterior({ ...base, points: [base.points[0]!, { ...base.points[1]!, binding: { gameId: "bj", station: 0 } }] })).toContain('binding bj/0 is declared twice');
  });
  it("reports stations that are not contiguous from 0", () => {
    expect(validateInterior({ ...base, points: [base.points[0]!, { ...base.points[1]!, binding: { gameId: "bj", station: 2 } }] })).toContain('stations for "bj" must be 0..n-1 without gaps');
  });
});
