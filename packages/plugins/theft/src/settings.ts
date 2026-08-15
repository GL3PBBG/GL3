export interface TheftSettings {
  cooldownSeconds: number;
  chase: { escapeChance: number; jailSeconds: number };
  repair: { costPerPoint: bigint };
}

/**
 * The three helpers below are copied rather than shared. Every plugin that
 * reads settings owns its own parser today (`combat/src/settings.ts`,
 * `oc/src/settings.ts`, `inventory/src/index.ts`); the SDK exposes none, and
 * reaching into another plugin's package for one would invert the dependency
 * direction the loader relies on.
 *
 * The blank check is load-bearing, not defensive noise: BOTH parsers coerce
 * an empty or whitespace-only string to ZERO (`Number("") === 0`,
 * `BigInt("") === 0n`) and zero passes the `>= 0` guard, so without it a
 * cleared admin field silently means "zero" instead of "use the default".
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
 * Keys are BARE — `cooldown_seconds`, not `theft.cooldown_seconds`. The SDK
 * namespaces them (`ctx.settings.get` looks up `<pluginId>.<key>`), which is
 * what stops one plugin reading another's configuration.
 *
 * `cooldownSeconds` is floored at 1 deliberately: a zero TTL makes Redis
 * `SET ... EX 0` fail, which is the exact live crash `travel_cooldown_seconds
 * = 0` still has. Not copied into a new module.
 */
export function readTheftSettings(get: (key: string) => string | null): TheftSettings {
  return {
    cooldownSeconds: Math.max(1, num(get, "cooldown_seconds", 300)),
    chase: {
      escapeChance: Math.min(100, num(get, "chase.escape_chance", 40)),
      jailSeconds: Math.max(1, num(get, "chase.jail_seconds", 600)),
    },
    repair: { costPerPoint: big(get, "repair.cost_per_point", 500n) },
  };
}
