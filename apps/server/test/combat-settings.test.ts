import { describe, expect, it } from "vitest";
import { readCombatSettings } from "@gl3/plugin-combat";

/** Builds the `get` the reader takes: a key→value map, missing keys null. */
function getter(values: Record<string, string>): (key: string) => string | null {
  return (key) => values[key] ?? null;
}

const NONE = getter({});

describe("readCombatSettings", () => {
  it("returns a playable configuration from an empty settings table", () => {
    expect(readCombatSettings(NONE)).toEqual({
      cooldownSeconds: 60,
      hospitalSeconds: 600,
      newbieExpThreshold: 100n,
      defaultWeaponAccuracy: 50,
      unarmed: { accuracy: 25, damageMin: 1, damageMax: 5, bulletsPerShot: 1 },
    });
  });

  it("takes every key from the database when all are set", () => {
    const settings = readCombatSettings(getter({
      "combat.cooldown_seconds": "90",
      "combat.hospital_seconds": "300",
      "combat.newbie_exp_threshold": "250",
      "combat.default_weapon_accuracy": "70",
      "combat.unarmed.accuracy": "40",
      "combat.unarmed.damage_min": "2",
      "combat.unarmed.damage_max": "8",
      "combat.unarmed.bullets_per_shot": "3",
    }));

    expect(settings).toEqual({
      cooldownSeconds: 90,
      hospitalSeconds: 300,
      newbieExpThreshold: 250n,
      defaultWeaponAccuracy: 70,
      unarmed: { accuracy: 40, damageMin: 2, damageMax: 8, bulletsPerShot: 3 },
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
      "combat.newbie_exp_threshold": "",
      "combat.unarmed.accuracy": "   ",
      "combat.default_weapon_accuracy": "\t\n",
    }));

    expect(settings.newbieExpThreshold).toBe(100n);
    expect(settings.unarmed.accuracy).toBe(25);
    expect(settings.defaultWeaponAccuracy).toBe(50);
  });

  it("falls back rather than throwing on a value that does not parse", () => {
    // `settings` is admin-edited free text; a typo must not take the attack
    // route down for everyone.
    const settings = readCombatSettings(getter({
      "combat.cooldown_seconds": "soon",
      "combat.newbie_exp_threshold": "lots",
      "combat.unarmed.damage_max": "NaN",
    }));

    expect(settings.cooldownSeconds).toBe(60);
    expect(settings.newbieExpThreshold).toBe(100n);
    expect(settings.unarmed.damageMax).toBe(5);
  });

  it("rejects a negative value in favour of the default", () => {
    const settings = readCombatSettings(getter({
      "combat.hospital_seconds": "-1",
      "combat.newbie_exp_threshold": "-5",
    }));

    expect(settings.hospitalSeconds).toBe(600);
    expect(settings.newbieExpThreshold).toBe(100n);
  });

  it("floors a fractional value so no float reaches the arithmetic", () => {
    expect(readCombatSettings(getter({ "combat.unarmed.damage_max": "7.9" })).unarmed.damageMax)
      .toBe(7);
  });

  it("never yields a zero cooldown, which Redis SET EX would reject", () => {
    // travel_cooldown_seconds = 0 is a live crash for exactly this reason
    // (docs/STATUS.md); the floor is here so combat does not inherit it.
    expect(readCombatSettings(getter({ "combat.cooldown_seconds": "0" })).cooldownSeconds).toBe(1);
    expect(readCombatSettings(getter({ "combat.hospital_seconds": "0" })).hospitalSeconds).toBe(1);
    expect(readCombatSettings(getter({ "combat.unarmed.bullets_per_shot": "0" }))
      .unarmed.bulletsPerShot).toBe(1);
  });

  it("clamps an accuracy above 100 so a typo cannot make every shot certain", () => {
    const settings = readCombatSettings(getter({
      "combat.default_weapon_accuracy": "1000",
      "combat.unarmed.accuracy": "150",
    }));

    expect(settings.defaultWeaponAccuracy).toBe(100);
    expect(settings.unarmed.accuracy).toBe(100);
  });

  it("accepts a newbie threshold beyond the range of a JS number", () => {
    // The threshold is compared against `player_stats.exp`, a bigint column;
    // routing it through Number() would lose precision at the top end.
    const huge = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 2
    expect(readCombatSettings(getter({ "combat.newbie_exp_threshold": huge })).newbieExpThreshold)
      .toBe(9007199254740993n);
  });
});
