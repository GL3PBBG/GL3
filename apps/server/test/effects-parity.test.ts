import { describe, expect, it } from "vitest";
// Neither plugin manifest declares an "./effects" exports subpath (only "."
// is exported, per packages/plugins/{combat,inventory}/package.json), and the
// brief forbids adding one just to make this test resolve — so both imports
// fall back to the relative path into each package's src.
import { WeaponEffectsSchema as CombatWeapon } from "../../../packages/plugins/combat/src/effects.js";
import { WeaponEffectsSchema as InventoryWeapon } from "../../../packages/plugins/inventory/src/effects.js";

/**
 * `effects.ts` is a VERBATIM COPY between the two plugins — a plugin may not
 * import another plugin, and both must read the same `items.effects` blob.
 * The copies are kept in step BY HAND and nothing else enforces it, so a
 * field added to one and not the other shows up as combat silently ignoring
 * a stat the player can see in their inventory. This test is that
 * enforcement.
 */
describe("weapon effects schema parity", () => {
  const fixture = {
    accuracy: 70,
    damageMin: 5,
    damageMax: 12,
    bulletsPerShot: 2,
    critChance: 10,
    critMultiplier: 1.5,
    armorPierce: 3,
    minRankExp: 400,
    backfireChance: 4,
  };

  it("parses one fixture identically through both copies", () => {
    expect(CombatWeapon.parse(fixture)).toEqual(InventoryWeapon.parse(fixture));
  });

  it("applies the same defaults to a minimal item", () => {
    const minimal = { damageMin: 1, damageMax: 2 };
    expect(CombatWeapon.parse(minimal)).toEqual(InventoryWeapon.parse(minimal));
  });

  it("rejects the same invalid input in both", () => {
    const bad = { damageMin: 9, damageMax: 2 };
    expect(CombatWeapon.safeParse(bad).success).toBe(false);
    expect(InventoryWeapon.safeParse(bad).success).toBe(false);
  });
});
