import { describe, expect, it } from "vitest";
import { readCombatSettings, rollFor } from "@gl3/plugin-combat";

/**
 * Builds the `get` the reader takes: a key→value map, missing keys null.
 *
 * Keys here are BARE, matching what the reader asks for. The SDK prepends the
 * plugin id, so the row in the `settings` table is `combat.cooldown_seconds`
 * while the reader asks for `cooldown_seconds`. That seam is invisible to
 * this file — a stub `get` answers whatever it is asked — which is exactly
 * how the double-prefix bug survived every test here. `combat.test.ts`'s
 * "reads the unarmed profile from the settings table" is the one that covers
 * it, and it has to go through a real HTTP request to do so.
 */
function getter(values: Record<string, string>): (key: string) => string | null {
  return (key) => values[key] ?? null;
}

const NONE = getter({});

describe("readCombatSettings", () => {
  it("returns a playable configuration from an empty settings table", () => {
    expect(readCombatSettings(NONE)).toEqual({
      cooldownSeconds: 60,
      cooldownMaxSeconds: 3600,
      hospitalSeconds: 600,
      newbieExpThreshold: 100n,
      defaultWeaponAccuracy: 50,
      // `dps` absent, not zero: a weapon (or fist) that declares no rate of
      // fire keeps the flat cooldown. See combat-cooldown.test.ts.
      unarmed: { accuracy: 25, damageMin: 1, damageMax: 5, bulletsPerShot: 1, dps: undefined },
      condition: { wearPerShot: 1, decayPeriodSeconds: 86_400, decayPerPeriod: 1 },
      backfire: { baseChance: 2, wearFactor: 3 },
      repair: { costPerPoint: 1000n },
    });
  });

  it("takes every key from the database when all are set", () => {
    const settings = readCombatSettings(getter({
      "cooldown_seconds": "90",
      "hospital_seconds": "300",
      "newbie_exp_threshold": "250",
      "default_weapon_accuracy": "70",
      "unarmed.accuracy": "40",
      "unarmed.damage_min": "2",
      "unarmed.damage_max": "8",
      "unarmed.bullets_per_shot": "3",
      "cooldown_max_seconds": "600",
      "unarmed.dps": "2",
    }));

    expect(settings).toEqual({
      cooldownSeconds: 90,
      cooldownMaxSeconds: 600,
      hospitalSeconds: 300,
      newbieExpThreshold: 250n,
      defaultWeaponAccuracy: 70,
      unarmed: { accuracy: 40, damageMin: 2, damageMax: 8, bulletsPerShot: 3, dps: 2 },
      condition: { wearPerShot: 1, decayPeriodSeconds: 86_400, decayPerPeriod: 1 },
      backfire: { baseChance: 2, wearFactor: 3 },
      repair: { costPerPoint: 1000n },
    });
  });

  it("treats a blank setting as absent, not as zero", () => {
    // The one that matters most. `Number("") === 0` and `BigInt("") === 0n`,
    // and zero passes the `>= 0` guard — so without the blank check a cleared
    // admin field silently means "zero". An empty newbie threshold would
    // disable newbie protection for the whole game and an empty unarmed
    // accuracy would make every unarmed attack miss forever, both with no
    // error anywhere.
    const settings = readCombatSettings(getter({
      "newbie_exp_threshold": "",
      "unarmed.accuracy": "   ",
      "default_weapon_accuracy": "\t\n",
    }));

    expect(settings.newbieExpThreshold).toBe(100n);
    expect(settings.unarmed.accuracy).toBe(25);
    expect(settings.defaultWeaponAccuracy).toBe(50);
  });

  it("falls back rather than throwing on a value that does not parse", () => {
    // `settings` is admin-edited free text; a typo must not take the attack
    // route down for everyone.
    const settings = readCombatSettings(getter({
      "cooldown_seconds": "soon",
      "newbie_exp_threshold": "lots",
      "unarmed.damage_max": "NaN",
    }));

    expect(settings.cooldownSeconds).toBe(60);
    expect(settings.newbieExpThreshold).toBe(100n);
    expect(settings.unarmed.damageMax).toBe(5);
  });

  it("rejects a negative value in favour of the default", () => {
    const settings = readCombatSettings(getter({
      "hospital_seconds": "-1",
      "newbie_exp_threshold": "-5",
    }));

    expect(settings.hospitalSeconds).toBe(600);
    expect(settings.newbieExpThreshold).toBe(100n);
  });

  it("floors a fractional value so no float reaches the arithmetic", () => {
    expect(readCombatSettings(getter({ "unarmed.damage_max": "7.9" })).unarmed.damageMax)
      .toBe(7);
  });

  it("never yields a zero cooldown, which Redis SET EX would reject", () => {
    // travel_cooldown_seconds = 0 is a live crash for exactly this reason
    // (docs/STATUS.md); the floor is here so combat does not inherit it.
    expect(readCombatSettings(getter({ "cooldown_seconds": "0" })).cooldownSeconds).toBe(1);
    expect(readCombatSettings(getter({ "hospital_seconds": "0" })).hospitalSeconds).toBe(1);
    expect(readCombatSettings(getter({ "unarmed.bullets_per_shot": "0" }))
      .unarmed.bulletsPerShot).toBe(1);
  });

  it("clamps an accuracy above 100 so a typo cannot make every shot certain", () => {
    const settings = readCombatSettings(getter({
      "default_weapon_accuracy": "1000",
      "unarmed.accuracy": "150",
    }));

    expect(settings.defaultWeaponAccuracy).toBe(100);
    expect(settings.unarmed.accuracy).toBe(100);
  });

  it("clamps an inverted unarmed range instead of letting randomInt throw", () => {
    // `rollFor` calls `randomInt(min, max + 1)`, which throws ERR_OUT_OF_RANGE
    // when min > max — a 500 on every unarmed shot in the game, from one typo
    // in a settings row. A weapon cannot reach this state (WeaponEffectsSchema
    // refuses damageMax < damageMin), so the settings table is the only way in.
    const settings = readCombatSettings(getter({
      "unarmed.damage_min": "10",
      "unarmed.damage_max": "6",
    }));

    expect(settings.unarmed).toMatchObject({ damageMin: 10, damageMax: 10 });
    // The assertion that matters: the profile it produces is one randomInt
    // accepts. Asserting the numbers alone would not have caught the throw.
    const profile = {
      ...settings.unarmed,
      critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
    };
    expect(() => rollFor(profile)).not.toThrow();
    expect(rollFor(profile).damageRoll).toBe(10);
  });

  it("accepts a newbie threshold beyond the range of a JS number", () => {
    // The threshold is compared against `player_stats.exp`, a bigint column;
    // routing it through Number() would lose precision at the top end.
    const huge = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 2
    expect(readCombatSettings(getter({ "newbie_exp_threshold": huge })).newbieExpThreshold)
      .toBe(9007199254740993n);
  });
});

describe("condition, backfire and repair settings", () => {
  const from = (map: Record<string, string>) =>
    readCombatSettings((key) => map[key] ?? null);

  it("defaults every new key", () => {
    const s = from({});
    expect(s.condition.wearPerShot).toBe(1);
    expect(s.condition.decayPeriodSeconds).toBe(86_400);
    expect(s.condition.decayPerPeriod).toBe(1);
    expect(s.backfire.baseChance).toBe(2);
    expect(s.backfire.wearFactor).toBe(3);
    expect(s.repair.costPerPoint).toBe(1000n);
  });

  it("reads bare keys, not combat-prefixed ones", () => {
    expect(from({ "backfire.base_chance": "40" }).backfire.baseChance).toBe(40);
    expect(from({ "combat.backfire.base_chance": "40" }).backfire.baseChance).toBe(2);
  });

  it("falls back rather than reading a blank value as zero", () => {
    const s = from({ "backfire.base_chance": "  ", "repair.cost_per_point": "" });
    expect(s.backfire.baseChance).toBe(2);
    expect(s.repair.costPerPoint).toBe(1000n);
  });

  it("floors the decay period at 1 so the division can never be by zero", () => {
    expect(from({ "condition.decay_period_seconds": "0" }).condition.decayPeriodSeconds).toBe(1);
  });

  it("caps the base chance at 100", () => {
    expect(from({ "backfire.base_chance": "500" }).backfire.baseChance).toBe(100);
  });
});
