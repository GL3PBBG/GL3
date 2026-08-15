import { describe, expect, it } from "vitest";
import { resolveShot, rollFor, type WeaponProfile } from "@gl3/plugin-combat";

// `backfireChance: 0` keeps the backfire branch unreachable for every test
// that predates it. It is not optional on `WeaponProfile`, and nothing
// typechecks this directory — no tsconfig includes `apps/server/test` — so
// omitting it would be a silent lie in the annotation rather than an error.
const base: WeaponProfile = {
  accuracy: 60, damageMin: 10, damageMax: 20, bulletsPerShot: 1,
  critChance: 0, critMultiplier: 2, armorPierce: 0, minRankExp: 0,
  backfireChance: 0,
};

describe("resolveShot", () => {
  it("misses when the hit roll is at or above accuracy", () => {
    const out = resolveShot(base, 0, { hitRoll: 60, damageRoll: 20, critRoll: 0 });
    expect(out).toEqual({
      hit: false, crit: false, damage: 0, armorAbsorbed: 0, bulletsSpent: 1,
      backfire: false, selfDamage: 0,
    });
  });

  it("hits when the roll is below accuracy", () => {
    const out = resolveShot(base, 0, { hitRoll: 59, damageRoll: 15, critRoll: 99 });
    expect(out.hit).toBe(true);
    expect(out.damage).toBe(15);
  });

  it("subtracts armor from the rolled damage", () => {
    const out = resolveShot(base, 6, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.damage).toBe(9);
    expect(out.armorAbsorbed).toBe(6);
  });

  it("reports a hit absorbed to zero as a hit, not a miss", () => {
    const out = resolveShot(base, 100, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.hit).toBe(true);
    expect(out.damage).toBe(0);
    expect(out.armorAbsorbed).toBe(15);
  });

  it("multiplies damage on a crit BEFORE armor subtracts", () => {
    const weapon = { ...base, critChance: 100, critMultiplier: 2 };
    const out = resolveShot(weapon, 10, { hitRoll: 0, damageRoll: 15, critRoll: 0 });
    // 15 × 2 = 30, then −10 armor = 20. Armor blunts a crit; it does not
    // bypass armor. Pierce is the stat that beats armor.
    expect(out.crit).toBe(true);
    expect(out.damage).toBe(20);
    expect(out.armorAbsorbed).toBe(10);
  });

  it("floors a fractional crit so damage stays an integer", () => {
    const weapon = { ...base, critChance: 100, critMultiplier: 1.5 };
    const out = resolveShot(weapon, 0, { hitRoll: 0, damageRoll: 15, critRoll: 0 });
    expect(out.damage).toBe(22); // floor(15 × 1.5) = 22
    expect(Number.isInteger(out.damage)).toBe(true);
  });

  it("reduces effective armor by armorPierce", () => {
    const weapon = { ...base, armorPierce: 8 };
    const out = resolveShot(weapon, 10, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.armorAbsorbed).toBe(2); // 10 − 8
    expect(out.damage).toBe(13);
  });

  it("never lets pierce turn armor into bonus damage", () => {
    const weapon = { ...base, armorPierce: 50 };
    const out = resolveShot(weapon, 10, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.armorAbsorbed).toBe(0);
    expect(out.damage).toBe(15);
  });

  it("charges bulletsPerShot on a miss as well as a hit", () => {
    const weapon = { ...base, bulletsPerShot: 7, accuracy: 0 };
    const out = resolveShot(weapon, 0, { hitRoll: 50, damageRoll: 15, critRoll: 99 });
    expect(out.hit).toBe(false);
    expect(out.bulletsSpent).toBe(7);
  });

  it("accuracy 100 always hits and accuracy 0 never does", () => {
    expect(resolveShot({ ...base, accuracy: 100 }, 0, { hitRoll: 99, damageRoll: 1, critRoll: 99 }).hit).toBe(true);
    expect(resolveShot({ ...base, accuracy: 0 }, 0, { hitRoll: 0, damageRoll: 1, critRoll: 99 }).hit).toBe(false);
  });
});

describe("rollFor", () => {
  it("stays inside the declared bounds over many draws", () => {
    const weapon = { ...base, damageMin: 5, damageMax: 9 };
    for (let i = 0; i < 200; i += 1) {
      const rolls = rollFor(weapon);
      expect(rolls.hitRoll).toBeGreaterThanOrEqual(0);
      expect(rolls.hitRoll).toBeLessThan(100);
      expect(rolls.critRoll).toBeGreaterThanOrEqual(0);
      expect(rolls.critRoll).toBeLessThan(100);
      expect(rolls.damageRoll).toBeGreaterThanOrEqual(5);
      expect(rolls.damageRoll).toBeLessThanOrEqual(9);
    }
  });

  it("produces more than one distinct damage value across draws", () => {
    // A loose sanity check, not an exact distribution assertion: this is the
    // one thing item-stat pinning cannot cover.
    const weapon = { ...base, damageMin: 1, damageMax: 100 };
    const seen = new Set(Array.from({ length: 50 }, () => rollFor(weapon).damageRoll));
    expect(seen.size).toBeGreaterThan(5);
  });

  it("returns damageMin when the weapon has no damage spread", () => {
    // randomInt(n, n + 1) is the degenerate case a fixed-damage weapon hits;
    // randomInt(n, n) would throw, so the +1 in rollFor is load-bearing.
    const weapon = { ...base, damageMin: 7, damageMax: 7 };
    expect(rollFor(weapon).damageRoll).toBe(7);
  });
});

describe("backfire", () => {
  const weapon: WeaponProfile = {
    accuracy: 100,
    damageMin: 10,
    damageMax: 10,
    bulletsPerShot: 2,
    critChance: 100,
    critMultiplier: 2,
    armorPierce: 0,
    minRankExp: 0,
    backfireChance: 50,
  };

  it("beats a hit roll that would otherwise connect", () => {
    const out = resolveShot(weapon, 5, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.backfire).toBe(true);
    expect(out.hit).toBe(false);
    expect(out.crit).toBe(false);
    expect(out.damage).toBe(0);
    expect(out.armorAbsorbed).toBe(0);
  });

  it("deals the raw damage roll to the attacker, unreduced by the target's armor", () => {
    const out = resolveShot(weapon, 99, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.selfDamage).toBe(10);
  });

  it("spends bullets anyway", () => {
    const out = resolveShot(weapon, 0, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.bulletsSpent).toBe(2);
  });

  it("does not fire when the roll is at or above the chance", () => {
    const out = resolveShot(weapon, 0, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 50 });
    expect(out.backfire).toBe(false);
    expect(out.hit).toBe(true);
  });

  it("is unreachable for a weapon declaring zero, even on roll 0", () => {
    const out = resolveShot({ ...weapon, backfireChance: 0 }, 0,
      { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.backfire).toBe(false);
  });

  it("reports selfDamage 0 on every non-backfire outcome", () => {
    const hit = resolveShot({ ...weapon, backfireChance: 0 }, 0,
      { hitRoll: 0, damageRoll: 10, critRoll: 99, backfireRoll: 0 });
    const miss = resolveShot({ ...weapon, accuracy: 0, backfireChance: 0 }, 0,
      { hitRoll: 50, damageRoll: 10, critRoll: 99, backfireRoll: 0 });
    expect(hit.selfDamage).toBe(0);
    expect(miss.selfDamage).toBe(0);
  });
});

describe("rollFor", () => {
  it("draws a backfire roll in [0, 100)", () => {
    for (let i = 0; i < 200; i += 1) {
      const rolls = rollFor({
        accuracy: 50, damageMin: 1, damageMax: 5, bulletsPerShot: 1,
        critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
        backfireChance: 5,
      });
      expect(rolls.backfireRoll).toBeGreaterThanOrEqual(0);
      expect(rolls.backfireRoll).toBeLessThan(100);
    }
  });
});
