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
 * Keys are BARE — `cooldown_seconds`, not `combat.cooldown_seconds`. The SDK
 * namespaces them: `ctx.settings.get` looks up `<pluginId>.<key>`
 * (`apps/server/src/plugins/ctx.ts:289`), which is what stops one plugin
 * reading another's configuration. Passing an already-prefixed key here
 * resolves `combat.combat.cooldown_seconds`, which never exists, so every
 * setting silently falls back to its default — no error, no log line. The
 * rows in the `settings` table are still `combat.cooldown_seconds`, exactly
 * as the design doc lists them; the prefix is just added on the other side.
 *
 * `cooldownSeconds` is floored at 1 deliberately: a zero TTL makes Redis
 * `SET ... EX 0` fail, which is the exact live crash `travel_cooldown_seconds
 * = 0` still has (see `docs/STATUS.md`). Not copied into a new module.
 */
export function readCombatSettings(get: (key: string) => string | null): CombatSettings {
  const damageMin = num(get, "unarmed.damage_min", 1);
  return {
    cooldownSeconds: Math.max(1, num(get, "cooldown_seconds", 60)),
    hospitalSeconds: Math.max(1, num(get, "hospital_seconds", 600)),
    newbieExpThreshold: big(get, "newbie_exp_threshold", 100n),
    defaultWeaponAccuracy: Math.min(100, num(get, "default_weapon_accuracy", 50)),
    unarmed: {
      accuracy: Math.min(100, num(get, "unarmed.accuracy", 25)),
      damageMin,
      // Clamped, because an admin who sets min above max would otherwise take
      // the route down: `rollFor` calls `randomInt(min, max + 1)`, which throws
      // `ERR_OUT_OF_RANGE` on an inverted range, and an unarmed attack is the
      // one path with no equipped item to fall back to. A weapon's own effects
      // cannot do this — `WeaponEffectsSchema` refuses `damageMax < damageMin`
      // and a rejected weapon falls back to this profile — so the settings
      // table is the only way in. Collapsing to a fixed `min` damage beats
      // 500ing every shot in the game.
      damageMax: Math.max(damageMin, num(get, "unarmed.damage_max", 5)),
      bulletsPerShot: Math.max(1, num(get, "unarmed.bullets_per_shot", 1)),
    },
  };
}
