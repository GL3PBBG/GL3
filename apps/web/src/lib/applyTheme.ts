import { THEME_VARS, ThemeResponseSchema, type Branding, type ThemeResponse } from "@gl3/shared";

/**
 * Branding is module state rather than React state because it arrives with the
 * same pre-render fetch that paints the palette — before any component tree
 * exists to own it. `useBranding` (BrandMark.tsx) reads it through
 * useSyncExternalStore, so the arrival re-renders whatever is mounted.
 * The default matches a server predating the field: GL3, no logos.
 */
const DEFAULT_BRANDING: Branding = { gameName: "GL3", logoLogin: null, logoHeader: null };
let branding: Branding = DEFAULT_BRANDING;
const brandingListeners = new Set<() => void>();

export function getBranding(): Branding {
  return branding;
}

export function subscribeBranding(listener: () => void): () => void {
  brandingListeners.add(listener);
  return () => { brandingListeners.delete(listener); };
}

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
  // The preset's name rides along too, so a stylesheet can do more than
  // recolour for a particular preset — the gangster skin plates its type in
  // chrome and gold and hangs a skyline behind the page only under
  // [data-theme="gangster"]. Every other preset gets the same structure in
  // flat colour. Attribute, not variable: the same reason as data-nav.
  root.setAttribute("data-theme", theme.preset);

  branding = theme.branding ?? DEFAULT_BRANDING;
  // The base title for the pre-auth pages (no Shell mounted). Shell's own
  // usePageTitle subscribes to this store and rewrites the title afterwards,
  // so this write never wins over a page label.
  document.title = branding.gameName;
  for (const listener of brandingListeners) listener();
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
