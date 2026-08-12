/** Settings are read via ctx.settings.get(key), which resolves DB row `oc.<key>`. */
export interface SettingsReader { get(key: string): string | null; }

export function readBigintSetting(settings: SettingsReader, key: string, fallback: bigint): bigint {
  const raw = settings.get(key);
  if (raw === null) return fallback;
  return /^\d+$/.test(raw) ? BigInt(raw) : fallback;
}

export function readNumberSetting(settings: SettingsReader, key: string, fallback: number): number {
  const raw = settings.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
