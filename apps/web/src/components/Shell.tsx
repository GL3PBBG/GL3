import { useEffect } from "react";
import type { ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  useJail, useLocations, useLogout, useMail, useMe, useNotifications, usePlugins, useRanks,
} from "../api/queries.js";
import { useSentenceCountdown } from "../hooks/useSentenceCountdown.js";
import { formatDuration } from "../lib/errors.js";
import { unreadCount } from "../lib/mail.js";
import { progressToNextRank } from "../lib/ranks.js";
import { EventFeed } from "./EventFeed.js";
import { Amount, Money } from "./ui.js";
import { SlotImage } from "./GameImage.js";
import styles from "./Shell.module.css";

const LINKS: ReadonlyArray<readonly [string, string]> = [
  ["/", "Dashboard"],
  ["/crimes", "Crimes"],
  ["/jail", "Jail"],
  ["/hospital", "Hospital"],
  ["/bank", "Bank"],
  ["/travel", "Travel"],
  ["/bullets", "Bullets"],
  ["/shop", "Shop"],
  ["/inventory", "Inventory"],
  ["/combat", "Combat"],
  ["/bounties", "Bounties"],
  ["/detectives", "Detectives"],
  ["/properties", "Properties"],
  ["/casino", "Casino"],
  ["/oc", "Heists"],
  ["/ranks", "Ranks"],
  ["/leaderboards", "Leaderboards"],
  ["/rounds", "Rounds"],
  ["/gang", "Gang"],
  ["/mail", "Mail"],
  ["/notifications", "Alerts"],
  ["/news", "News"],
  ["/profile", "Profile"],
];

function Stat({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      {children}
    </span>
  );
}


/**
 * Which singleton art slot each route's banner comes from.
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
const PAGE_BANNERS: Record<string, { slot: string; alt: string }> = {
  "/crimes": { slot: "page-crimes", alt: "Crimes" },
  "/jail": { slot: "page-jail", alt: "Jail" },
  "/hospital": { slot: "page-hospital", alt: "Hospital" },
  "/bank": { slot: "page-bank", alt: "Bank" },
  "/casino": { slot: "page-casino", alt: "Casino" },
  "/combat": { slot: "page-combat", alt: "Combat" },
  "/bounties": { slot: "page-bounties", alt: "Bounties" },
  "/detectives": { slot: "page-detectives", alt: "Detectives" },
  "/oc": { slot: "page-oc", alt: "Organized crime" },
  "/properties": { slot: "page-properties", alt: "Properties" },
  "/garage": { slot: "page-garage", alt: "Garage" },
  "/theft": { slot: "page-theft", alt: "Car theft" },
  "/gang": { slot: "page-gang", alt: "Gang" },
  "/mail": { slot: "page-mail", alt: "Mail" },
  "/news": { slot: "page-news", alt: "News" },
  "/shop": { slot: "page-shop", alt: "Shop" },
  "/bullets": { slot: "page-bullets", alt: "Bullet shop" },
  "/travel": { slot: "page-travel", alt: "Travel" },
  "/ranks": { slot: "page-ranks", alt: "Ranks" },
  "/leaderboards": { slot: "page-leaderboards", alt: "Leaderboards" },
};

function PageBanner(): JSX.Element | null {
  const { pathname } = useLocation();
  // Exact match on the first path segment, so `/mail/:threadId` shares the mail
  // banner and an unknown route quietly gets none.
  const key = `/${pathname.split("/")[1] ?? ""}`;
  const banner = PAGE_BANNERS[key];
  if (banner === undefined) return null;
  return (
    <div className={styles.pageBanner}>
      <SlotImage scope="core" slot={banner.slot} alt={banner.alt} size="lg" />
    </div>
  );
}

/**
 * Per-route document titles. An SPA leaves `<title>` at whatever index.html
 * shipped, so every tab, every history entry and — for a screen-reader user,
 * who hears the title to learn a page changed — every navigation reads "GL3".
 */
function usePageTitle(pluginLabelFor: (pageId: string) => string | undefined): void {
  const { pathname } = useLocation();
  // Computed per render, effect keyed on the result: a plugin page's label
  // arrives with the plugins query, possibly after the navigation that needs
  // it, and the title must catch up when it does.
  const [, first, second] = pathname.split("/");
  let label: string | undefined;
  if (first === "" || first === undefined) label = "Dashboard";
  else if (first === "admin") label = "Admin";
  else if (first === "plugins" && second !== undefined) {
    label = pluginLabelFor(decodeURIComponent(second));
  } else label = LINKS.find(([to]) => to === `/${first}`)?.[1];
  const title = label === undefined ? "GL3" : `${label} — GL3`;
  useEffect(() => { document.title = title; }, [title]);
}

export function Shell(): JSX.Element {
  const me = useMe();
  const jail = useJail();
  const ranks = useRanks();
  const locations = useLocations();
  const logout = useLogout();
  const mail = useMail();
  const notifications = useNotifications();
  const plugins = usePlugins();

  // The banner is on screen on every page, so it is the countdown a player
  // watches most — it has to tick between anchors like /jail does.
  const jailSeconds = useSentenceCountdown(
    "jail", jail.data?.jailed === true ? jail.data.remainingSeconds : undefined,
    jail.dataUpdatedAt,
  );

  // `order` is the only thing that field is for, so the nav is the one place it
  // has to be honoured. Sorted on a copy — the array belongs to the query cache
  // — and tie-broken on pageId so two entries sharing an order stay put across
  // refetches instead of swapping places.
  const pluginLinks = [...(plugins.data?.menu ?? [])]
    .sort((a, b) => a.order - b.order || a.pageId.localeCompare(b.pageId));

  usePageTitle((pageId) => pluginLinks.find((entry) => entry.pageId === pageId)?.label);

  // /api/auth/me carries neither rank nor location; both are derived from the
  // list endpoints, which is why the HUD depends on three queries.
  const rank = me.data ? progressToNextRank(me.data.exp, ranks.data?.ranks ?? []) : null;
  const here = locations.data?.locations.find((location) => location.current);

  // Neither endpoint reports a count, so both lists are counted here. They are
  // held by the shell rather than the pages so a badge moves on the WS
  // invalidation while the player is somewhere else entirely — which is the
  // only reason to have a badge at all.
  const badges: Readonly<Record<string, number>> = {
    "/mail": unreadCount(mail.data?.mail ?? []),
    "/notifications": (notifications.data?.notifications ?? [])
      .filter((notification) => notification.readAt === null).length,
  };

  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <header className={styles.header}>
        <h1 className={styles.brand}>GL3</h1>
        <div className={styles.hud}>
          <Stat label="Player">{me.data?.username ?? "—"}</Stat>
          <Stat label="Cash">{me.data ? <Money value={me.data.cash} /> : "—"}</Stat>
          <Stat label="Bank">{me.data ? <Money value={me.data.bank} /> : "—"}</Stat>
          <Stat label="Bullets">{me.data ? <Amount value={me.data.bullets} /> : "—"}</Stat>
          <Stat label="Exp">{me.data ? <Amount value={me.data.exp} /> : "—"}</Stat>
          <Stat label="Rank">{rank?.current?.name ?? "Unranked"}</Stat>
          <Stat label="Location">{here?.name ?? "Nowhere"}</Stat>
          <button type="button" disabled={logout.isPending} onClick={() => { logout.mutate(); }}>
            Log out
          </button>
        </div>
      </header>

      <nav className={styles.nav}>
        {LINKS.map(([to, label]) => {
          const unread = badges[to] ?? 0;
          return (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                isActive ? `${styles.navLink} ${styles.navActive}` : styles.navLink
              }
            >
              {label}
              {unread > 0 ? (
                <span className={styles.badge}>
                  {unread}<span className={styles.srOnly}> unread</span>
                </span>
              ) : null}
            </NavLink>
          );
        })}
        {/*
          Plugin entries sit below the core links and carry no badge: a badge is
          a count the shell polls for, and nothing in the manifest supplies one.
          The link target is the namespaced route, not the entry's declared
          `path` — see the routing note in App.tsx. `pageId` is only constrained
          to be non-empty, so it is encoded rather than trusted as a path segment.
        */}
        {me.data && me.data.grants.length > 0 ? (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              isActive ? `${styles.navLink} ${styles.navActive}` : styles.navLink
            }
          >
            Admin
          </NavLink>
        ) : null}
        {pluginLinks.map((entry) => (
          <NavLink
            key={entry.pageId}
            to={`/plugins/${encodeURIComponent(entry.pageId)}`}
            className={({ isActive }) =>
              isActive ? `${styles.navLink} ${styles.navActive}` : styles.navLink
            }
          >
            {entry.label}
          </NavLink>
        ))}
      </nav>

      {jail.data?.jailed === true ? (
        <p className={styles.jailBanner} role="status">
          In jail — {formatDuration(jailSeconds)} remaining.
        </p>
      ) : null}

      <div className={styles.body}>
        <main id="main" className={styles.content}>
          <PageBanner />
          <Outlet />
        </main>
        <EventFeed />
      </div>
    </div>
  );
}
