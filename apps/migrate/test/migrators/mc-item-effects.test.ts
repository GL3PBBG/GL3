import { describe, expect, it } from "vitest";
import { mapMcItemEffects } from "../../src/migrators/mc-item-effects.js";

/**
 * MCCodes' generic item effect engine (`itemuse.php`): up to three
 * `{stat, dir, inc_amount, inc_type}` records per item, `inc_type = percent`
 * being a share of the stat's MAX for the four capped stats. GL3 expresses
 * the ones it has a def for — energy/will/brave through the built-in `pools`
 * def, a positive hp through `heal`, percents kept as the `"N%"` figure the
 * defs resolve at use time. Anything else is parked under `kind: "mccodes"`
 * so a use fails clean (`unknown_effect`) and a future def can read it.
 */
const eff = (stat: string, dir: string, inc_amount: number, inc_type: string) =>
  ({ stat, dir, inc_amount, inc_type });

describe("mapMcItemEffects", () => {
  it("maps a percent pool effect onto the pools def as a percent figure", () => {
    expect(mapMcItemEffects([eff("will", "pos", 25, "percent")])).toEqual({
      effects: { kind: "pools", pools: { will: "25%" } }, notes: [],
    });
  });

  it("maps a flat pool effect, signed by dir", () => {
    expect(mapMcItemEffects([eff("energy", "neg", 10, "figure")]).effects)
      .toEqual({ kind: "pools", pools: { energy: -10 } });
  });

  it("maps several pool effects onto one pools record in effect order", () => {
    expect(mapMcItemEffects([
      eff("brave", "pos", 3, "figure"), eff("energy", "neg", 20, "percent"),
    ]).effects).toEqual({ kind: "pools", pools: { brave: 3, energy: "-20%" } });
  });

  it("maps a positive hp effect onto the heal def", () => {
    expect(mapMcItemEffects([eff("hp", "pos", 50, "percent")]).effects).toEqual({ heal: "50%" });
    expect(mapMcItemEffects([eff("hp", "pos", 40, "figure")]).effects).toEqual({ heal: 40 });
  });

  it("parks a mixed heal-and-pool item under kind mccodes — no def reads both", () => {
    const raw = [eff("hp", "pos", 50, "percent"), eff("energy", "pos", 10, "figure")];
    const out = mapMcItemEffects(raw);
    expect(out.effects).toEqual({ kind: "mccodes", mccodes: raw });
    expect(out.notes).toHaveLength(1);
  });

  it("parks a stat GL3 has no def for, and a negative hp, under kind mccodes", () => {
    for (const raw of [[eff("money", "pos", 500, "figure")], [eff("hp", "neg", 10, "figure")]]) {
      const out = mapMcItemEffects(raw);
      expect(out.effects).toEqual({ kind: "mccodes", mccodes: raw });
      expect(out.notes).toHaveLength(1);
    }
  });

  it("parks the same pool named twice — GL3 carries one delta per pool", () => {
    const raw = [eff("energy", "pos", 5, "figure"), eff("energy", "pos", 10, "percent")];
    expect(mapMcItemEffects(raw).effects).toEqual({ kind: "mccodes", mccodes: raw });
  });

  it("parks a malformed record (zero amount, unknown dir or inc_type) rather than guessing", () => {
    for (const raw of [
      [eff("energy", "pos", 0, "figure")],
      [eff("energy", "sideways", 5, "figure")],
      [eff("energy", "pos", 5, "ratio")],
      [{ stat: "energy", dir: "pos", inc_amount: "5", inc_type: "figure" }],
    ]) {
      const out = mapMcItemEffects(raw);
      expect(out.effects, JSON.stringify(raw)).toEqual({ kind: "mccodes", mccodes: raw });
      expect(out.notes).toHaveLength(1);
    }
  });
});
