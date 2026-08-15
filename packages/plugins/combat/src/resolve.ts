import { randomInt } from "node:crypto";

export interface WeaponProfile {
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
