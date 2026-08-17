import { describe, expect, it } from "vitest";
import { cooldownSecondsFor, readCombatSettings } from "@gl3/plugin-combat";

/**
 * The attack cooldown used to be one flat number for every weapon
 * (`combat.cooldown_seconds`). It is now derived from the weapon's own rate of
 * fire: a weapon declaring `dps` waits long enough to have dealt exactly that
 * much damage per second, so a 10-damage gun at 1 dps waits 10 seconds and the
 * same gun at 0.5 dps waits 20.
 *
 * The average of the damage range is the divisor, not the roll: the cooldown is
 * claimed BEFORE the transaction that rolls damage (`index.ts`, the anti-probe
 * ordering), so a roll-derived cooldown is not available at the point the TTL
 * has to be chosen. Averaging also keeps a weapon's rhythm a property of the
 * weapon rather than of luck.
 */
const config = { cooldownSeconds: 60, cooldownMaxSeconds: 3600 };

describe("cooldownSecondsFor", () => {
  it("waits one second per point of damage at 1 dps", () => {
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: 1 }, config)).toBe(10);
  });

  it("doubles the wait when the dps halves", () => {
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: 0.5 }, config)).toBe(20);
  });

  it("divides the average of the damage range, not either end", () => {
    // 5..15 averages 10, so it paces identically to the fixed 10 above. A
    // max-based rule would give 15 and a min-based one 5.
    expect(cooldownSecondsFor({ damageMin: 5, damageMax: 15, dps: 1 }, config)).toBe(10);
  });

  it("rounds a fractional wait up, never down", () => {
    // 10 damage at 3 dps is 3.33s. Rounding down would let a weapon out-pace
    // its own declared dps, and the TTL is whole seconds either way.
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: 3 }, config)).toBe(4);
  });

  it("keeps the static cooldown for a weapon that declares no dps", () => {
    // Every migrated V2 item arrives without one — `itemEffects` has no such
    // column — so this is the case that keeps the live game playing exactly as
    // it did before the field existed.
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10 }, config)).toBe(60);
  });

  it("never yields a zero cooldown, which Redis SET EX would reject", () => {
    // A fast weapon rounds up to 1 rather than to 0: `SET ... EX 0` fails, the
    // exact live crash travel_cooldown_seconds = 0 still has.
    expect(cooldownSecondsFor({ damageMin: 1, damageMax: 1, dps: 100 }, config)).toBe(1);
  });

  it("caps a very low dps at the configured maximum", () => {
    // Without the cap, `dps: 0.001` on a 10-damage weapon is a 10,000-second
    // lockout — nearly three hours — from one admin typo.
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: 0.001 }, config)).toBe(3600);
  });

  it("falls back to the static cooldown rather than dividing by zero", () => {
    // The schema refuses a non-positive dps, so this is only reachable through
    // a hand-written row — but 10/0 is Infinity, which reaches Redis as a TTL.
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: 0 }, config)).toBe(60);
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: -1 }, config)).toBe(60);
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: Number.NaN }, config)).toBe(60);
  });

  it("takes both bounds from the settings a real caller passes it", () => {
    // Guards the wiring, not the arithmetic: the fallback is
    // `cooldown_seconds` and the cap is `cooldown_max_seconds`, and swapping
    // the two reads is invisible at the defaults.
    const settings = readCombatSettings((key) =>
      ({ "cooldown_seconds": "90", "cooldown_max_seconds": "120" })[key] ?? null
    );
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10 }, settings)).toBe(90);
    expect(cooldownSecondsFor({ damageMin: 10, damageMax: 10, dps: 0.01 }, settings)).toBe(120);
  });
});

describe("cooldown settings", () => {
  const from = (map: Record<string, string>) => readCombatSettings((key) => map[key] ?? null);

  it("defaults the cap to an hour", () => {
    expect(from({}).cooldownMaxSeconds).toBe(3600);
  });

  it("floors the cap at 1, since it is itself a Redis TTL", () => {
    expect(from({ "cooldown_max_seconds": "0" }).cooldownMaxSeconds).toBe(1);
  });

  it("has no unarmed dps by default, so fists keep the static cooldown", () => {
    expect(from({}).unarmed.dps).toBeUndefined();
  });

  it("reads a fractional unarmed dps without flooring it", () => {
    // The one float in the settings reader: `num` floors, and a floored 0.5
    // would be 0 — the unarmed cooldown would silently stop being derived.
    expect(from({ "unarmed.dps": "0.5" }).unarmed.dps).toBe(0.5);
  });

  it("treats a blank, unparseable or non-positive unarmed dps as absent", () => {
    expect(from({ "unarmed.dps": "  " }).unarmed.dps).toBeUndefined();
    expect(from({ "unarmed.dps": "fast" }).unarmed.dps).toBeUndefined();
    expect(from({ "unarmed.dps": "0" }).unarmed.dps).toBeUndefined();
    expect(from({ "unarmed.dps": "-2" }).unarmed.dps).toBeUndefined();
  });
});
