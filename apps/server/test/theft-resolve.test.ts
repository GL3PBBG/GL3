import { describe, expect, it } from "vitest";
import { boostedChance, bracketWeight, resolveTheft, type CatalogueCar, type TheftRolls, type TheftTier }
  from "@gl3/plugin-theft";

const car = (name: string, value: bigint, theftWeight: number): CatalogueCar =>
  ({ id: `id-${name}`, name, value, theftWeight });

const TIER: TheftTier = {
  id: "t", name: "Backstreet", successChance: 60, maxDamage: 20,
  minCarValue: 1000n, maxCarValue: 5000n,
};

const rolls = (over: Partial<TheftRolls> = {}): TheftRolls =>
  ({ successRoll: 0, carRoll: 0, damageRoll: 0, escapeRoll: 0, ...over });

const BEATER = car("Beater", 1000n, 1);
const SEDAN = car("Sedan", 3000n, 4);
const SUPERCAR = car("Supercar", 90000n, 1);
const CATALOGUE = [BEATER, SEDAN, SUPERCAR];

describe("bracketWeight", () => {
  it("sums the weights of cars inside the tier's value bracket only", () => {
    expect(bracketWeight(TIER, CATALOGUE)).toBe(5); // Supercar is out of bracket
  });

  it("counts a car sitting exactly on either bound", () => {
    const edges = [car("Low", 1000n, 2), car("High", 5000n, 3)];
    expect(bracketWeight(TIER, edges)).toBe(5);
  });

  it("is zero when the bracket is empty", () => {
    expect(bracketWeight(TIER, [SUPERCAR])).toBe(0);
  });

  it("ignores a negative weight rather than subtracting it", () => {
    // theft_weight is admin-edited. A negative value must not shrink the
    // draw space, which would make the weighted scan skip real cars.
    expect(bracketWeight(TIER, [BEATER, car("Bad", 2000n, -10)])).toBe(1);
  });
});

describe("resolveTheft", () => {
  it("succeeds when successRoll is below the tier's chance", () => {
    const out = resolveTheft(rolls({ successRoll: 59 }), TIER, CATALOGUE, 40);
    expect(out.kind).toBe("stolen");
  });

  it("fails when successRoll equals the tier's chance", () => {
    // The boundary is `<`, so a 60% tier fails on exactly 60 out of 0..99.
    expect(resolveTheft(rolls({ successRoll: 60 }), TIER, CATALOGUE, 40).kind).not.toBe("stolen");
  });

  it("never succeeds at successChance 0 and always succeeds at 100", () => {
    const never = { ...TIER, successChance: 0 };
    const always = { ...TIER, successChance: 100 };
    expect(resolveTheft(rolls({ successRoll: 0 }), never, CATALOGUE, 0).kind).toBe("caught");
    expect(resolveTheft(rolls({ successRoll: 99 }), always, CATALOGUE, 0).kind).toBe("stolen");
  });

  it("draws the car by weight, in catalogue order", () => {
    // Beater has weight 1 and Sedan 4, so rolls 0 -> Beater and 1..4 -> Sedan.
    const pick = (carRoll: number) => {
      const out = resolveTheft(rolls({ successRoll: 0, carRoll }), TIER, CATALOGUE, 40);
      if (out.kind !== "stolen") throw new Error(`expected stolen, got ${out.kind}`);
      return out.car.name;
    };
    expect(pick(0)).toBe("Beater");
    expect(pick(1)).toBe("Sedan");
    expect(pick(4)).toBe("Sedan");
  });

  it("never draws a car outside the bracket", () => {
    for (let carRoll = 0; carRoll < 5; carRoll += 1) {
      const out = resolveTheft(rolls({ successRoll: 0, carRoll }), TIER, CATALOGUE, 40);
      if (out.kind !== "stolen") throw new Error("expected stolen");
      expect(out.car.name).not.toBe("Supercar");
    }
  });

  it("reports an empty bracket rather than throwing or picking nothing", () => {
    expect(resolveTheft(rolls({ successRoll: 0 }), TIER, [SUPERCAR], 40).kind).toBe("empty");
  });

  it("stays total when carRoll lands past the total weight", () => {
    // Defensive: a caller that drew against a stale weight must still get a
    // car, not undefined.
    const out = resolveTheft(rolls({ successRoll: 0, carRoll: 999 }), TIER, CATALOGUE, 40);
    expect(out.kind).toBe("stolen");
  });

  it("passes the damage roll through and clamps it to the tier's maximum", () => {
    const at = (damageRoll: number) => {
      const out = resolveTheft(rolls({ successRoll: 0, damageRoll }), TIER, CATALOGUE, 40);
      if (out.kind !== "stolen") throw new Error("expected stolen");
      return out.damage;
    };
    expect(at(7)).toBe(7);
    expect(at(999)).toBe(20);
    expect(at(-3)).toBe(0);
  });

  it("yields a pristine car for a tier whose maxDamage is 0", () => {
    const pristine = { ...TIER, maxDamage: 0 };
    const out = resolveTheft(rolls({ successRoll: 0, damageRoll: 0 }), pristine, CATALOGUE, 40);
    if (out.kind !== "stolen") throw new Error("expected stolen");
    expect(out.damage).toBe(0);
  });

  it("escapes when escapeRoll is below the escape chance, and is caught otherwise", () => {
    const failed = rolls({ successRoll: 99 });
    expect(resolveTheft({ ...failed, escapeRoll: 39 }, TIER, CATALOGUE, 40).kind).toBe("escaped");
    expect(resolveTheft({ ...failed, escapeRoll: 40 }, TIER, CATALOGUE, 40).kind).toBe("caught");
  });

  it("never escapes at chance 0 and always escapes at 100", () => {
    const failed = rolls({ successRoll: 99 });
    expect(resolveTheft({ ...failed, escapeRoll: 0 }, TIER, CATALOGUE, 0).kind).toBe("caught");
    expect(resolveTheft({ ...failed, escapeRoll: 99 }, TIER, CATALOGUE, 100).kind).toBe("escaped");
  });

  it("runs the chase even when the bracket is empty", () => {
    // An empty bracket is only reachable on the SUCCESS branch; a failed
    // theft is a chase regardless of what was on the street.
    expect(resolveTheft(rolls({ successRoll: 99, escapeRoll: 0 }), TIER, [], 40).kind).toBe("escaped");
  });
});

describe("boostedChance", () => {
  it("boosts a member's chance by 10%", () => {
    expect(boostedChance(50, true)).toBe(55);
  });

  it("caps a boosted chance at 100", () => {
    expect(boostedChance(95, true)).toBe(100);
  });

  it("floors a fractional boost", () => {
    expect(boostedChance(59, true)).toBe(64); // floor(64.9)
  });

  it("leaves a non-member's chance untouched", () => {
    expect(boostedChance(50, false)).toBe(50);
  });
});
