import { THEME_VARS, ThemeResponseSchema, type ThemeResponse } from "@gl3/shared";

/**
 * Paints the server's resolved palette over theme.css's :root fallback as
 * inline custom properties. theme.css keeps the midnight values so the first
 * frame is never unstyled while the fetch is in flight.
 */
export function applyTheme(theme: ThemeResponse): void {
  const root = document.documentElement;
  for (const v of THEME_VARS) root.style.setProperty(`--${v}`, theme.colors[v]);
  // Layout rides an attribute, not a variable: Shell.module.css keys its
  // left-sidebar rules off [data-nav="left"], so React never re-renders for a
  // layout change — CSS does all of it.
  root.setAttribute("data-nav", theme.layout.nav);
}

/**
 * Fire-and-forget at boot. Public endpoint — no token, so the login page is
 * themed too. A failed or malformed response leaves the CSS fallback in
 * place; theming is never worth blocking render on.
 */
export async function loadTheme(): Promise<void> {
  try {
    const response = await fetch("/api/theme");
    if (!response.ok) return;
    const parsed = ThemeResponseSchema.safeParse(await response.json());
    if (parsed.success) applyTheme(parsed.data);
  } catch {
    // offline or mid-deploy — the fallback palette stands
  }
}
