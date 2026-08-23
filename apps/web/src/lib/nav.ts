/**
 * The navigation's information architecture: which destinations exist and
 * which category each belongs to.
 *
 * The nav used to be one flat list of ~25 links rendered as a wrapping row —
 * two dense lines on desktop, six on a phone. The categories here replace
 * that: every renderer (the top category bar, the left accordion sidebar and
 * the mobile drawer) consumes this same structure, so a destination's home is
 * decided exactly once.
 *
 * Jail and Hospital live in Town, not Crimes: they are places you are taken
 * to and buy your way out of — town services, in the government sense —
 * rather than things you do. Actions has no core items at all: it exists for
 * a plugin page that belongs between Crimes and Town, and buildNav drops it
 * when nothing does.
 */

export interface NavEntry {
  /** Router destination. Plugin pages use their namespaced /plugins/<pageId> path. */
  to: string;
  label: string;
}

export interface NavCategory {
  id: string;
  label: string;
  items: readonly NavEntry[];
}

/**
 * Every id in `NAV_CATEGORIES` has a category below, and nothing below is
 * absent from it. The list is what the SDK validates a plugin's declared
 * `menu.category` against, so a category a plugin may name must be one this
 * table can render into — the parity test in nav.test.ts holds the two ends
 * together.
 */
export type { NavCategoryId } from "@gl3/shared";

const HOME: NavCategory = {
  id: "home",
  label: "Home",
  items: [{ to: "/", label: "Dashboard" }],
};

const CRIMES: NavCategory = {
  id: "crimes",
  label: "Crimes",
  items: [
    { to: "/crimes", label: "Crimes" },
    { to: "/combat", label: "Combat" },
    { to: "/bounties", label: "Bounties" },
    { to: "/detectives", label: "Detectives" },
    { to: "/oc", label: "Heists" },
  ],
};

/* Plugin-only: rendered between Crimes and Town when a plugin page routes
   here (PLUGIN_CATEGORY below), dropped entirely when none does. */
const ACTIONS: NavCategory = {
  id: "actions",
  label: "Actions",
  items: [],
};

const TOWN: NavCategory = {
  id: "town",
  label: "Town",
  items: [
    { to: "/bank", label: "Bank" },
    { to: "/shop", label: "Shop" },
    { to: "/bullets", label: "Bullets" },
    { to: "/casino", label: "Casino" },
    { to: "/travel", label: "Travel" },
    { to: "/jail", label: "Jail" },
    { to: "/hospital", label: "Hospital" },
  ],
};

const SOCIAL: NavCategory = {
  id: "social",
  label: "Social",
  items: [
    { to: "/mail", label: "Mail" },
    { to: "/forum", label: "Forum" },
    { to: "/gang", label: "Gang" },
    { to: "/players", label: "Players" },
    { to: "/news", label: "News" },
    { to: "/notifications", label: "Alerts" },
  ],
};

const ACCOUNT: NavCategory = {
  id: "account",
  label: "Account",
  items: [
    { to: "/profile", label: "Profile" },
    { to: "/stats", label: "Stats" },
    { to: "/ranks", label: "Ranks" },
    { to: "/leaderboards", label: "Leaderboards" },
    { to: "/rounds", label: "Rounds" },
    { to: "/admin", label: "Admin" },
  ],
};

/**
 * The fallback home for plugin pages that do NOT declare one, keyed by pageId.
 *
 * A page now names its own category in its manifest (`menu.category`, carried
 * on `PluginMenuEntry.category`) and that always wins — this map is what is
 * left of the phase-one stand-in, kept for pages authored before the field
 * existed so their nav position survives untouched. New plugins should declare
 * instead of being added here; a page in neither still falls into the trailing
 * "More" category rather than being dropped or silently misfiled.
 *
 * The core tables above deliberately contain no plugin entries: a plugin
 * page's item (label and all) comes from the server's manifest alone, so it
 * exists exactly once and disappears with the plugin.
 */
export const PLUGIN_CATEGORY: Readonly<Record<string, string>> = {
  "theft.index": "crimes",
  "theft.garage": "town",
  "membership.index": "account",
};

/** The menu entries the plugins endpoint returns — `MenuItem` from shared. */
export interface PluginMenuEntry {
  pageId: string;
  path: string;
  label: string;
  order: number;
  /** The page's own declared category, when it has one. Beats PLUGIN_CATEGORY. */
  category?: string | undefined;
}

/**
 * Assemble the categories the shell renders: the core table above, with the
 * server's plugin entries folded into their mapped categories (labels come
 * from the manifest, not from here) and any unmapped ones collected under
 * "More" in their declared order. The Admin link is dropped entirely for
 * players without grants — the route would 403 for them anyway.
 */
export function buildNav(
  pluginLinks: readonly PluginMenuEntry[],
  options: { admin: boolean; pluginCategory?: Readonly<Record<string, string>> },
): NavCategory[] {
  // Assembled mutable, returned frozen-shaped: plugin entries get pushed in
  // below, which NavCategory's readonly items cannot express.
  type MutableCategory = { id: string; label: string; items: NavEntry[] };
  const byId = new Map<string, MutableCategory>(
    [HOME, CRIMES, ACTIONS, TOWN, SOCIAL, ACCOUNT].map(
      (c) => [c.id, { id: c.id, label: c.label, items: [...c.items] }],
    ),
  );
  const extra: NavEntry[] = [];
  const pluginCategory = options.pluginCategory ?? PLUGIN_CATEGORY;
  for (const entry of pluginLinks) {
    // Raw pageId, not its encoding: this is the same literal a `menu.badges`
    // subscriber writes and the same value navKeyFor decodes the location
    // down to, so badges and active-state match on one canonical form. The
    // encoding happens at the very edge, in linkFor, where the router needs
    // it — nowhere in between.
    const to = `/plugins/${entry.pageId}`;
    // Declared beats mapped: the plugin owns where it lives, and the map is
    // only the fallback for pages that name nothing. An id the table does not
    // know cannot reach here from the SDK (`z.enum(NAV_CATEGORIES)`), but a
    // hand-rolled payload could, and it lands in "More" like any unmapped page.
    const target = byId.get(entry.category ?? pluginCategory[entry.pageId] ?? "");
    if (target !== undefined) target.items.push({ to, label: entry.label });
    else extra.push({ to, label: entry.label });
  }
  if (options.admin === false) {
    const account = byId.get("account")!;
    account.items = account.items.filter((item) => item.to !== "/admin");
  }
  // Empty categories do not render: Actions exists as a plugin target, so
  // with nothing routed to it, it must vanish rather than sit as a header
  // with nothing under it.
  const categories = [...byId.values()].filter((c) => c.items.length > 0);
  if (extra.length > 0) categories.push({ id: "more", label: "More", items: extra });
  return categories;
}

/**
 * The path a nav lookup should key on: the first segment for core routes
 * (so `/mail/:threadId` resolves to `/mail`) and the first two for plugin
 * pages, whose pageId IS the second segment. Decoded, because NavLink targets
 * carry `encodeURIComponent`'s output for pageIds that need it.
 */
export function navKeyFor(pathname: string): string {
  const [, first, second] = pathname.split("/");
  if (first === "plugins" && second !== undefined && second !== "") {
    return `/plugins/${decodeURIComponent(second)}`;
  }
  return `/${first ?? ""}`;
}

/** The category containing a route, or null for routes the nav does not know. */
export function categoryForPath(
  categories: readonly NavCategory[],
  pathname: string,
): NavCategory | null {
  const key = navKeyFor(pathname);
  return categories.find((c) => c.items.some((item) => item.to === key)) ?? null;
}

/**
 * The href a nav item renders. Core paths pass through; a plugin page's
 * pageId — unconstrained charset in the SDK — is encoded here, the one place
 * a browser-facing string is needed. The inverse of navKeyFor's decode: a
 * pageId that encodes still round-trips to its raw nav path.
 */
export function linkFor(item: NavEntry): string {
  if (!item.to.startsWith("/plugins/")) return item.to;
  return `/plugins/${encodeURIComponent(item.to.slice("/plugins/".length))}`;
}

/** A route's nav label — the document title's source. Undefined when unknown. */
export function labelForPath(
  categories: readonly NavCategory[],
  pathname: string,
): string | undefined {
  return categoryForPath(categories, pathname)?.items.find(
    (item) => item.to === navKeyFor(pathname),
  )?.label;
}

/**
 * A category's rolled-up unread count: the sum of its items' badges. Shown on
 * the category button itself, so a collapsed group still signals what is
 * waiting inside it.
 */
export function categoryBadge(
  category: NavCategory,
  badges: Readonly<Record<string, number>>,
): number {
  return category.items.reduce((sum, item) => sum + (badges[item.to] ?? 0), 0);
}
