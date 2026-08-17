export interface BulletSettings {
  stockMinPerHour: number;
  stockMaxPerHour: number;
  maxStock: number;
  /** `null` is unlimited. V2's `method_options` passes no default for this. */
  maxCost: bigint | null;
  /** `null` is unlimited, likewise. */
  maxBuy: number | null;
}

/**
 * Copied rather than shared, following `theft/src/settings.ts`'s note: every
 * plugin that reads settings owns its own parser, the SDK exposes none, and
 * reaching into another plugin's package for one would invert the dependency
 * direction the loader relies on.
 *
 * The blank check is load-bearing: `Number("") === 0` and `BigInt("") === 0n`
 * both pass a `>= 0` guard, so without it a cleared admin field would mean
 * "restock zero bullets an hour" rather than "use the default".
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

/** Absent, blank or unparseable all mean unlimited — there is no third state. */
function optionalNum(get: (key: string) => string | null, key: string): number | null {
  const raw = get(key);
  if (blank(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function optionalBig(get: (key: string) => string | null, key: string): bigint | null {
  const raw = get(key);
  if (blank(raw)) return null;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Keys are BARE — `max_stock`, not `bullets.max_stock`. The SDK namespaces them
 * (`ctx.settings.get` looks up `<pluginId>.<key>`), which is what stops one
 * plugin reading another's configuration.
 *
 * Defaults are V2's, from `bullets.inc.php`: 2250/2750 an hour and a 40000
 * ceiling. `stockMaxPerHour` is raised to meet an inverted `stockMinPerHour`
 * rather than swapped with it — `randomInt(min, max + 1)` THROWS when
 * `min > max`, which would 500 every shop view, and raising honours the
 * figure the admin actually typed as a minimum.
 */
export function readBulletSettings(get: (key: string) => string | null): BulletSettings {
  const stockMinPerHour = num(get, "stock_min_per_hour", 2250);
  return {
    stockMinPerHour,
    stockMaxPerHour: Math.max(stockMinPerHour, num(get, "stock_max_per_hour", 2750)),
    maxStock: num(get, "max_stock", 40000),
    maxCost: optionalBig(get, "max_cost"),
    maxBuy: optionalNum(get, "max_buy"),
  };
}
