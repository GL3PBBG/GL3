export interface CombatSettings {
  cooldownSeconds: number;
  hospitalSeconds: number;
  newbieExpThreshold: bigint;
  defaultWeaponAccuracy: number;
  unarmed: {
    accuracy: number;
    damageMin: number;
    damageMax: number;
    bulletsPerShot: number;
  };
}

/**
 * Every key has a default, so a fresh database with an empty `settings` table
 * still plays. A malformed value falls back rather than throwing: `settings`
 * is admin-edited free text and a typo must not take the route down.
 *
 * The blank check is load-bearing, not defensive noise. BOTH parsers coerce an
 * empty or whitespace-only string to ZERO rather than rejecting it —
 * `Number("") === 0` and `BigInt("") === 0n` — and zero passes the `>= 0`
 * guard, so without this line a cleared setting field silently means "zero"
 * instead of "use the default". That is not hypothetical: an empty
 * `combat.newbie_exp_threshold` would disable newbie protection for the whole
 * game, and an empty `combat.unarmed.accuracy` would make every unarmed
 * attack miss forever. Both fail silently, with no error anywhere.
 */
function blank(raw: string | null): raw is null {
  return raw === null || raw.trim() === "";
}

function num(get: (key: string) => string | null, key: string, fallback: number): number {
  const raw = get(key);
  if (blank(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function big(get: (key: string) => string | null, key: string, fallback: bigint): bigint {
  const raw = get(key);
  if (blank(raw)) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * `cooldownSeconds` is floored at 1 deliberately: a zero TTL makes Redis
 * `SET ... EX 0` fail, which is the exact live crash `travel_cooldown_seconds
 * = 0` still has (see `docs/STATUS.md`). Not copied into a new module.
 */
export function readCombatSettings(get: (key: string) => string | null): CombatSettings {
  return {
    cooldownSeconds: Math.max(1, num(get, "combat.cooldown_seconds", 60)),
    hospitalSeconds: Math.max(1, num(get, "combat.hospital_seconds", 600)),
    newbieExpThreshold: big(get, "combat.newbie_exp_threshold", 100n),
    defaultWeaponAccuracy: Math.min(100, num(get, "combat.default_weapon_accuracy", 50)),
    unarmed: {
      accuracy: Math.min(100, num(get, "combat.unarmed.accuracy", 25)),
      damageMin: num(get, "combat.unarmed.damage_min", 1),
      damageMax: num(get, "combat.unarmed.damage_max", 5),
      bulletsPerShot: Math.max(1, num(get, "combat.unarmed.bullets_per_shot", 1)),
    },
  };
}
