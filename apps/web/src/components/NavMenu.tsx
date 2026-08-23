import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { categoryBadge, linkFor, type NavCategory } from "../lib/nav.js";
import styles from "./NavMenu.module.css";

/**
 * One stroke icon per category. Not a dependency on an icon package: six
 * 24×24 paths copied once keep the bundle flat, and the whole point of the
 * icons is to give the eye an anchor per category — a bespoke set of six is
 * all the design ever asked for. `currentColor` so CSS can recolor per state.
 */
const ICON_PATHS: Record<string, readonly string[]> = {
  home: ["m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
  // A crosshair: two concentric circles (each one full arc pair) plus ticks.
  crimes: [
    "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18",
    "M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8",
    "M12 3v5", "M12 16v5", "M3 12h5", "M16 12h5",
  ],
  actions: [
    "M4.5 16.5 16.5 4.5", "M14 4.5h2.5V7", "M4.5 14v2.5H7",
    "M4.5 16.5 7.5 19.5 19.5 7.5 16.5 4.5 4.5 16.5Z",
  ],
  town: ["M3 21h18", "M5 21V7l7-4 7 4v14", "M9 21v-4h6v4", "M9 10h.01", "M15 10h.01", "M9 14h.01", "M15 14h.01"],
  social: ["M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.7L3 21l1.8-5.6a8.38 8.38 0 0 1-.8-3.9 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5Z"],
  account: [
    "M12 4a4 4 0 1 0 0 8 4 4 0 1 0 0-8",
    "M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5",
  ],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
};

function CategoryIcon({ id }: { id: string }): JSX.Element {
  const paths = ICON_PATHS[id] ?? ICON_PATHS.more!;
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/**
 * The categorized nav, laid out by CSS into whichever chrome the theme and
 * viewport call for: a horizontal category bar whose open category drops a
 * panel (default `data-nav="top"`), or a vertical accordion (the admin's
 * `data-nav="left"` sidebar) — the same markup, exactly like the flat nav it
 * replaced, so React never re-renders for a layout choice.
 *
 * Open-state policy is shared by both: exactly one category is open at a
 * time, and by default it is the active route's — so the player lands on a
 * page with its own group already expanded. Toggling a header overrides that
 * until the next navigation resets it. One mechanism serving both shapes is
 * what keeps the two layouts from drifting apart behaviourally.
 */
export function NavMenu({
  categories, badges, activeKey, variant = "bar", className,
}: {
  categories: readonly NavCategory[];
  /** Unread counts keyed by nav path — core paths and `/plugins/<pageId>` alike. */
  badges: Readonly<Record<string, number>>;
  /** `navKeyFor(pathname)` for the current route; decides the default open category. */
  activeKey: string;
  /**
   * "bar" is the horizontal category bar; "drawer" forces the accordion
   * shape. The sidebar shape needs no variant — CSS keys it off the theme's
   * [data-nav] attribute — but the phone drawer must be an accordion no
   * matter which desktop layout the admin picked, so it says so explicitly.
   */
  variant?: "bar" | "drawer";
  className?: string | undefined;
}): JSX.Element {
  const activeCategory = categories.find(
    (c) => c.items.some((item) => item.to === activeKey),
  );
  // `undefined` means "follow the route" (no override); `null` means the
  // player closed what the route had opened.
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  useEffect(() => { setOverride(undefined); }, [activeKey]);
  const openId = override === undefined ? (activeCategory?.id ?? null) : override;

  // A dropdown loses its dismiss affordances when focus moves into the page,
  // so a pointerdown outside the nav closes it. In sidebar mode the same
  // listener collapses the accordion on content interaction — consistent, and
  // the active group re-expands on the next navigation anyway.
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (openId === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOverride(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openId]);

  const classes = [styles.nav];
  if (variant === "drawer") classes.push(styles.drawerNav);
  if (className !== undefined) classes.push(className);
  // The shell renders this component twice (the bar and, on a phone, the
  // drawer), so an id must carry its variant or the two copies would mint
  // identical `aria-controls` targets — the bar's hidden-but-present DOM
  // would shadow the drawer's.
  const idFor = (categoryId: string): string => `${variant}-${categoryId}-items`;

  return (
    <nav ref={rootRef} className={classes.join(" ")}>
      {categories.map((category) => {
        const open = category.id === openId;
        const containsActive = category.id === activeCategory?.id;
        const unread = categoryBadge(category, badges);
        return (
          <div key={category.id} className={open ? `${styles.cat} ${styles.open}` : styles.cat}>
            <button
              type="button"
              className={containsActive ? `${styles.catBtn} ${styles.catActive}` : styles.catBtn}
              aria-expanded={open}
              aria-controls={idFor(category.id)}
              onClick={() => { setOverride(open ? null : category.id); }}
            >
              <CategoryIcon id={category.id} />
              {category.label}
              {unread > 0 ? (
                <span className={styles.catBadge}>
                  {unread}<span className={styles.srOnly}> unread</span>
                </span>
              ) : null}
              {/* The chevron is the only open/closed cue besides the panel
                  itself, so it rotates rather than merely sitting there. */}
              <svg
                className={styles.chev}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              ><path d="m9 6 6 6-6 6" /></svg>
            </button>
            <div id={idFor(category.id)} className={styles.items}>
              {category.items.map((item) => {
                const itemUnread = badges[item.to] ?? 0;
                return (
                  <NavLink
                    key={item.to}
                    to={linkFor(item)}
                    end={item.to === "/"}
                    className={({ isActive }) =>
                      isActive ? `${styles.item} ${styles.itemActive}` : styles.item
                    }
                  >
                    {item.label}
                    {itemUnread > 0 ? (
                      <span className={styles.itemBadge}>
                        {itemUnread}<span className={styles.srOnly}> unread</span>
                      </span>
                    ) : null}
                  </NavLink>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
