/**
 * Per-route banner art, one map for every page's chrome.
 *
 * One map here rather than a `<SlotImage>` inside each of nineteen page
 * components: a banner is chrome, it belongs to the layout, and every page
 * would otherwise have to remember to draw one — which is exactly how the
 * `location` and `rank` slots ended up bindable with nothing rendering them.
 *
 * A route with no entry simply has no banner. So does one whose slot has no
 * art bound: `SlotImage` renders null rather than a placeholder, because empty
 * space at the top of a page is better than a hatched grey box on every page of
 * a fresh install.
 */
export const PAGE_BANNERS: Record<string, { slot: string; alt: string }> = {
  "/plugins/crimes.index": { slot: "page-crimes", alt: "Crimes" },
  // Jail draws its own banner rather than living in this map: it is the one
  // state-dependent slot, switching to `page-supermax` while the caller sits
  // in super max — see Jail.tsx.
  "/plugins/hospital": { slot: "page-hospital", alt: "Hospital" },
  "/bank": { slot: "page-bank", alt: "Bank" },
  "/plugins/casino.index": { slot: "page-casino", alt: "Casino" },
  "/plugins/combat.index": { slot: "page-combat", alt: "Combat" },
  "/plugins/bounties.index": { slot: "page-bounties", alt: "Bounties" },
  "/plugins/detectives.index": { slot: "page-detectives", alt: "Detectives" },
  "/plugins/oc.index": { slot: "page-oc", alt: "Organized crime" },
  "/plugins/gangs.index": { slot: "page-gang", alt: "Gang" },
  "/mail": { slot: "page-mail", alt: "Mail" },
  "/news": { slot: "page-news", alt: "News" },
  "/shop": { slot: "page-shop", alt: "Shop" },
  "/plugins/bullets.index": { slot: "page-bullets", alt: "Bullet shop" },
  "/plugins/travel.index": { slot: "page-travel", alt: "Travel" },
  "/ranks": { slot: "page-ranks", alt: "Ranks" },
  "/leaderboards": { slot: "page-leaderboards", alt: "Leaderboards" },
  "/inventory": { slot: "page-inventory", alt: "Inventory" },
  "/rounds": { slot: "page-rounds", alt: "Rounds" },
  "/stats": { slot: "page-stats", alt: "Stats" },
  "/forum": { slot: "page-forum", alt: "Forum" },
  "/players": { slot: "page-players", alt: "Players" },
  // The page's old address renders the same component — same banner.
  "/online": { slot: "page-players", alt: "Players" },
  "/profile": { slot: "page-profile", alt: "Profile" },
  "/notifications": { slot: "page-notifications", alt: "Notifications" },
  "/": { slot: "page-dashboard", alt: "Dashboard" },
  // Manifest-declared gameplay pages are keyed by their full /plugins/<pageId>
  // path (navKeyFor's second segment), same as /theft and /garage would be.
};

/**
 * Resolves a pathname to its banner, if any. Tries the exact pathname first —
 * required for `/plugins/<pageId>` routes, which collide on their shared
 * `/plugins` first segment — then falls back to the first path segment, so a
 * detail route like `/mail/:threadId` still shares its list page's banner.
 * A route matching neither is a route with no banner, not an error.
 */
export function bannerSlotFor(pathname: string): { slot: string; alt: string } | null {
  const exact = PAGE_BANNERS[pathname];
  if (exact !== undefined) return exact;
  const firstSegment = `/${pathname.split("/")[1] ?? ""}`;
  return PAGE_BANNERS[firstSegment] ?? null;
}
