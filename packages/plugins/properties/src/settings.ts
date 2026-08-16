export interface PropertiesSettings {
  income: { cap: bigint; defaultRate: bigint };
  admin: { canEditRate: boolean };
}

/**
 * The three helpers below are copied rather than shared. Every plugin that
 * reads settings owns its own parser today (`combat/src/settings.ts`,
 * `oc/src/settings.ts`, `theft/src/settings.ts`); the SDK exposes none, and
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

function flag(get: (key: string) => string | null, key: string, fallback: boolean): boolean {
  const raw = get(key);
  if (raw === null || raw.trim() === "") return fallback;
  return raw.trim() === "true" ? true : raw.trim() === "false" ? false : fallback;
}

/**
 * Keys are BARE — `income.cap`, not `properties.income.cap`. The SDK
 * namespaces them (`ctx.settings.get` looks up `<pluginId>.<key>`), which is
 * what stops one plugin reading another's configuration.
 *
 * `canEditRate` is informational (spec §4): the admin page always edits
 * `rate`; the key exists so a future runmode can pin it. Nothing reads it
 * yet — that is the spec's instruction, not dead code to delete.
 */
export function readPropertiesSettings(get: (key: string) => string | null): PropertiesSettings {
  return {
    income: {
      cap: big(get, "income.cap", 1_000_000n),
      defaultRate: big(get, "income.default_rate", 500n),
    },
    admin: { canEditRate: flag(get, "admin.can_edit_rate", true) },
  };
}
