import { HexColorSchema, NavPositionSchema, THEME_VARS, type NavPosition, type ThemeColors, type ThemeVar } from "@gl3/shared";

/**
 * Curated palettes. `midnight` IS theme.css's fallback palette — the two must
 * agree or an unthemed install flashes from one to the other while
 * `GET /api/theme` is in flight.
 */
export const THEME_PRESETS: Record<string, ThemeColors> = {
  midnight: {
    bg: "#101014", fg: "#e6e6ea", accent: "#c8963e", success: "#5bbd7a",
    danger: "#d2564f", muted: "#8d8d99", panel: "#17171c", line: "#2a2a30",
  },
  noir: {
    bg: "#0c0c0c", fg: "#e8e8e8", accent: "#b8b8b8", success: "#9fd0ae",
    danger: "#d98a85", muted: "#7c7c7c", panel: "#161616", line: "#2c2c2c",
  },
  crimson: {
    bg: "#140e0e", fg: "#ece4e2", accent: "#c2453c", success: "#5bbd7a",
    danger: "#e06c65", muted: "#9a8a87", panel: "#1c1313", line: "#332523",
  },
  emerald: {
    bg: "#0d1310", fg: "#e2eae4", accent: "#3fae72", success: "#6fcf97",
    danger: "#d2564f", muted: "#87988d", panel: "#131b16", line: "#24312a",
  },
};

export const DEFAULT_PRESET = "midnight";

const PRESET_KEY = "theme.preset";
const NAV_KEY = "theme.nav";
const OVERRIDE_PREFIX = "theme.override.";

/**
 * Resolve settings rows into the wire shape. Defensive on both limbs: an
 * unknown stored preset falls back to midnight and a non-hex stored override
 * is ignored, because these rows are plain V2-style settings an operator can
 * hand-edit — a bad row must degrade, never 500 the login page.
 */
export function resolveTheme(rows: { key: string; value: string }[]): {
  preset: string; colors: ThemeColors; layout: { nav: NavPosition };
} {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const stored = byKey.get(PRESET_KEY);
  const preset = stored !== undefined && stored in THEME_PRESETS ? stored : DEFAULT_PRESET;
  const colors = { ...THEME_PRESETS[preset]! };
  for (const v of THEME_VARS) {
    const override = byKey.get(`${OVERRIDE_PREFIX}${v}`);
    if (override !== undefined && HexColorSchema.safeParse(override).success) colors[v] = override;
  }
  const navParsed = NavPositionSchema.safeParse(byKey.get(NAV_KEY));
  const nav = navParsed.success ? navParsed.data : "top";
  return { preset, colors, layout: { nav } };
}

export function presetKey(): string {
  return PRESET_KEY;
}

export function navKey(): string {
  return NAV_KEY;
}

export function overrideKey(v: ThemeVar): string {
  return `${OVERRIDE_PREFIX}${v}`;
}
