import type { InteriorDecl } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { exitSpotFor, validateInterior } from "../src/world/interior.js";

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

describe("exitSpotFor (spec §4.2)", () => {
  const b = { minX: -40, minY: -20, maxX: 40, maxY: 20 };
  const fp = { w: 12, d: 9 };
  it("stands 3 m in front of a north-side door facing south", () => {
    expect(exitSpotFor({ position: { x: 10, y: 15 }, facing: Math.PI, footprint: fp }, b)).toEqual({ x: 10, y: 7.5, facing: Math.PI });
  });
  it("stands 3 m in front of a south-side door facing north", () => {
    expect(exitSpotFor({ position: { x: -10, y: -15 }, facing: 0, footprint: fp }, b)).toEqual({ x: -10, y: -7.5, facing: 0 });
  });
  it("handles east/west template facings (12 m side along y, depth along x)", () => {
    const e = exitSpotFor({ position: { x: 61, y: 18 }, facing: Math.PI / 2, footprint: fp }, { minX: -120, minY: -20, maxX: 70, maxY: 100 });
    expect(e.x).toBeCloseTo(53.5); expect(e.y).toBeCloseTo(18); expect(e.facing).toBe(Math.PI / 2);
  });
  it("clamps to the street bounds", () => {
    expect(exitSpotFor({ position: { x: 39, y: 15 }, facing: Math.PI, footprint: fp }, { minX: -40, minY: 8, maxX: 40, maxY: 20 }).y).toBe(8);
  });
});
