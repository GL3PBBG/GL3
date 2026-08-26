import { randomInt } from "node:crypto";

export interface WeaponProfile {
  /**
   * Which resolution model this weapon carries (C6). Absent = "firearm" —
   * every pre-existing profile literal stays valid untouched.
   */
  model?: "firearm" | "melee";
  /** Melee only: flat weapon power from the item's effects. */
  power?: number;
  accuracy: number;
  damageMin: number;
  damageMax: number;
  bulletsPerShot: number;
  critChance: number;
  critMultiplier: number;
  armorPierce: number;
  minRankExp: number;
  /**
   * Already scaled by condition — `backfireChanceFor` is applied by the
   * caller, so this stays pure and knows nothing about wear.
   */
  backfireChance: number;
}

export interface ShotOutcome {
  hit: boolean;
  crit: boolean;
  damage: number;
  armorAbsorbed: number;
  bulletsSpent: number;
  /** The weapon went off in the attacker's hand. Not a miss. */
  backfire: boolean;
  /** Damage dealt to the ATTACKER. 0 on every non-backfire outcome. */
  selfDamage: number;
}

/** The four draws a shot needs, taken by the caller so this stays pure. */
export interface Rolls {
  hitRoll: number;
  damageRoll: number;
  critRoll: number;
  backfireRoll: number;
}

/**
 * `node:crypto`, never `Math.random` (spec §7). Kept separate from
 * `resolveShot` so the arithmetic can be tested exhaustively without an RNG
 * injected into shipped code — the shape the bullets port rejected.
 *
 * The `+ 1` on the damage bound is inclusive-max, and load-bearing for a
 * fixed-damage weapon: `randomInt(n, n)` throws.
 */
export function rollFor(weapon: WeaponProfile): Rolls {
  return {
    hitRoll: randomInt(0, 100),
    damageRoll: randomInt(weapon.damageMin, weapon.damageMax + 1),
    critRoll: randomInt(0, 100),
    backfireRoll: randomInt(0, 100),
  };
}

/**
 * Two-stage: roll to hit, then roll damage.
 *
 * A crit multiplies BEFORE armor subtracts, so armor blunts a crit rather
 * than a crit bypassing armor. Pierce is the stat that beats armor; crit is
 * the stat that beats health. Two counters, two distinct roles.
 *
 * A hit reduced to zero by armor still reports `hit: true` — "your armor
 * held" is different information from "he missed."
 *
 * Bullets are spent either way: ammo is the cost of shooting, not of hitting.
 */
export function resolveShot(
  weapon: WeaponProfile,
  targetArmor: number,
  rolls: Rolls,
): ShotOutcome {
  const bulletsSpent = weapon.bulletsPerShot;

  // BEFORE the hit roll, deliberately. A backfire is not a miss — the gun
  // went off in your hand, and the hit roll never happens. Ordering it after
  // would make a backfire impossible on any shot that connects, which is
  // exactly backwards.
  //
  // Self-damage is the raw damage roll reduced by NO armor: not the target's
  // (irrelevant — nothing reached them) and not the attacker's (armor does
  // not protect you from your own weapon).
  if (rolls.backfireRoll < weapon.backfireChance) {
    return {
      backfire: true,
      hit: false,
      crit: false,
      damage: 0,
      armorAbsorbed: 0,
      selfDamage: rolls.damageRoll,
      bulletsSpent,
    };
  }

  if (rolls.hitRoll >= weapon.accuracy) {
    return { hit: false, crit: false, damage: 0, armorAbsorbed: 0, bulletsSpent, backfire: false, selfDamage: 0 };
  }

  const crit = rolls.critRoll < weapon.critChance;
  // floor keeps damage an integer despite critMultiplier being a float — no
  // float may reach a bigint or the ledger.
  const raw = crit
    ? Math.floor(rolls.damageRoll * weapon.critMultiplier)
    : rolls.damageRoll;

  const effectiveArmor = Math.max(0, targetArmor - weapon.armorPierce);
  const damage = Math.max(0, raw - effectiveArmor);
  const armorAbsorbed = raw - damage;

  return { hit: true, crit, damage, armorAbsorbed, bulletsSpent, backfire: false, selfDamage: 0 };
}

// ---------------------------------------------------------------------------
// MELEE (C6, audit §7 item 9) — MCCodes' stat-driven resolution, the second
// model a weapon can carry. Firearms keep resolveShot above, byte-identical;
// the two never share arithmetic, only the ShotOutcome shape the shot path
// downstream consumes.
// ---------------------------------------------------------------------------

export interface MeleeInput {
  /** Flat weapon power, from the item's effects jsonb. */
  power: number;
  attStrength: number;
  attAgility: number;
  defGuard: number;
  defAgility: number;
  targetArmor: number;
}

/** The four draws a strike needs, taken by the caller so this stays pure. */
export interface MeleeRolls {
  hitRoll: number;
  /** rand(8000, 12000), divided by 10000 — the ±20% swing. */
  damageRoll: number;
  /** d40: 17 crits (index 16), 8 and 25 (7, 24) weaken. */
  critRoll: number;
  /** rand(20, 40), tenths — the crit/weak multiplier magnitude. */
  critAmountRoll: number;
}

export function rollMelee(): MeleeRolls {
  return {
    hitRoll: randomInt(0, 100),
    damageRoll: randomInt(8000, 12001),
    critRoll: randomInt(0, 40),
    critAmountRoll: randomInt(20, 41),
  };
}

/**
 * Verbatim MCCodes math (attack.php:198-236): hit chance is the agility
 * ratio clamped to 10–95, damage is `power × strength ÷ (guard/1.5)` with
 * the ±20% swing, minus flat armor with a minimum-1 floor — an armored
 * target cannot fully negate a connected strike. The crit table is the d40:
 * a 17 multiplies by ×2–4, an 8 or 25 divides by ÷2–4.
 *
 * Zero stats are normalized to 1 in the two divisors — GL3-native rows
 * carry zeros MCCodes never could, and a division by zero is not balance.
 */
export function resolveMeleeStrike(input: MeleeInput, rolls: MeleeRolls): ShotOutcome {
  const miss: ShotOutcome = {
    hit: false, crit: false, damage: 0, armorAbsorbed: 0,
    bulletsSpent: 0, backfire: false, selfDamage: 0,
  };

  const ratio = Math.max(10, Math.min((60 * input.attAgility) / Math.max(1, input.defAgility), 95));
  if (rolls.hitRoll >= ratio) return miss;

  let raw = Math.floor(
    (input.power * input.attStrength) / (Math.max(1, input.defGuard) / 1.5)
      * (rolls.damageRoll / 10000),
  );
  let crit = false;
  if (rolls.critRoll === 16) {
    raw = Math.floor((raw * rolls.critAmountRoll) / 10);
    crit = true;
  } else if (rolls.critRoll === 7 || rolls.critRoll === 24) {
    raw = Math.max(1, Math.floor(raw / (rolls.critAmountRoll / 10)));
  }

  const damage = Math.max(1, raw - input.targetArmor);
  return {
    hit: true, crit,
    damage,
    armorAbsorbed: Math.max(0, raw - damage),
    bulletsSpent: 0, backfire: false, selfDamage: 0,
  };
}
