import { z } from "zod";

/**
 * The 8 CSS variables `apps/web/src/theme.css` paints from. The names ARE the
 * custom-property names (applied as `--bg`, `--fg`, ...), so adding one here
 * without a fallback value in theme.css leaves it unset for any client that
 * loads before an admin has ever saved the theme.
 */
export const THEME_VARS = ["bg", "fg", "accent", "success", "danger", "muted", "panel", "line"] as const;
export type ThemeVar = (typeof THEME_VARS)[number];

export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const ThemeColorsSchema = z.object(
  Object.fromEntries(THEME_VARS.map((v) => [v, HexColorSchema])) as Record<ThemeVar, typeof HexColorSchema>,
);
export type ThemeColors = z.infer<typeof ThemeColorsSchema>;

export const NavPositionSchema = z.enum(["top", "left"]);
export type NavPosition = z.infer<typeof NavPositionSchema>;

/**
 * Operator branding: the game's display name plus the two logo slots
 * (`core:logo-login` full-size, `core:logo-header` small). Rides the theme
 * payload because the login page needs all of it before any session exists —
 * the slot-image route is authenticated, so it cannot serve the login logo.
 */
export const BrandingSchema = z.object({
  gameName: z.string(),
  logoLogin: z.string().nullable(),
  logoHeader: z.string().nullable(),
});
export type Branding = z.infer<typeof BrandingSchema>;

/** `GET /api/theme` — public; the login page is themed too. Colors arrive
 *  fully resolved (preset merged with overrides) so the client stays dumb.
 *  `branding` is optional so a payload from a server predating it still
 *  parses — the client falls back to the GL3 defaults. */
export const ThemeResponseSchema = z.object({
  preset: z.string(),
  colors: ThemeColorsSchema,
  layout: z.object({ nav: NavPositionSchema }),
  branding: BrandingSchema.optional(),
});
export type ThemeResponse = z.infer<typeof ThemeResponseSchema>;
