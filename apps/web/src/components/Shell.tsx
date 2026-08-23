import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router-dom";
import {
  useHudExtras, useJail, useLocations, useLogout, useMail, useMe, useMenuBadges,
  useNotifications, usePlugins, useRanks,
} from "../api/queries.js";
import { useSentenceCountdown } from "../hooks/useSentenceCountdown.js";
import { secondsLeft } from "../lib/countdown.js";
import { formatDuration } from "../lib/errors.js";
import { FormatProvider } from "../lib/formatContext.js";
import { unreadCount } from "../lib/mail.js";
import { buildNav, labelForPath, navKeyFor, type NavCategory } from "../lib/nav.js";
import { progressToNextRank } from "../lib/ranks.js";
import { EventFeed } from "./EventFeed.js";
import { NavMenu } from "./NavMenu.js";
import { Amount, Money } from "./ui.js";
import { SlotImage } from "./GameImage.js";
import styles from "./Shell.module.css";

function Stat({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      {children}
    </span>
  );
}

/**
 * A live "Xs" / "Xm YYs" for a plugin-supplied HUD entry's `countdownTo`.
 *
 * Unlike `useSentenceCountdown`, `countdownTo` already arrives as an absolute
 * ISO timestamp rather than a relative-seconds snapshot needing an anchor, so
 * there is no shared deadline map to seed here — a plain 1s interval
 * recomputing from `Date.now()` is the whole hook.
 */
function CountdownValue({ to }: { to: string }): JSX.Element {
  const deadline = new Date(to).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => window.clearInterval(tick);
  }, []);
  return <>{formatDuration(secondsLeft(deadline, now))}</>;
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
  "/gang": { slot: "page-gang", alt: "Gang" },
  "/mail": { slot: "page-mail", alt: "Mail" },
  "/news": { slot: "page-news", alt: "News" },
  "/shop": { slot: "page-shop", alt: "Shop" },
  "/bullets": { slot: "page-bullets", alt: "Bullet shop" },
  "/travel": { slot: "page-travel", alt: "Travel" },
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
  // No /theft or /garage entries: those pages are manifest-declared and live
  // at /plugins/<pageId>, which this first-segment map cannot reach. A plugin
  // page's banner is a `slotImage` node in the plugin's own view.
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
      {/* Not zoomable: the banner already renders at natural size up to the
          content width, and a zoom control on page chrome is noise. */}
      <SlotImage scope="core" slot={banner.slot} alt={banner.alt} size="banner" zoomable={false} />
    </div>
  );
}

/**
 * Per-route document titles. An SPA leaves `<title>` at whatever index.html
 * shipped, so every tab, every history entry and — for a screen-reader user,
 * who hears the title to learn a page changed — every navigation reads "GL3".
 *
 * The label comes from the built nav (lib/nav.ts), which knows every
 * destination the menu knows, labels included — the one table that already
 * had this mapping, now that LINKS is gone.
 */
function usePageTitle(categories: readonly NavCategory[]): void {
  const { pathname } = useLocation();
  // Computed per render, effect keyed on the result: a plugin page's label
  // arrives with the plugins query, possibly after the navigation that needs
  // it, and the title must catch up when it does.
  const label = labelForPath(categories, pathname);
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
  const hudExtras = useHudExtras();
  const menuBadges = useMenuBadges();

  const { pathname } = useLocation();
  const activeKey = navKeyFor(pathname);

  // The drawer (phones) and the account menu (desktop) are the two pieces of
  // transient chrome the header owns; both close on Escape and on the outside
  // click of their openers.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drawerOpen && !accountOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setDrawerOpen(false);
      setAccountOpen(false);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (accountRef.current !== null && !accountRef.current.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [drawerOpen, accountOpen]);

  // While the drawer covers the page the body behind it must not scroll.
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen]);

  // Focus moves into the drawer when it opens and back to the hamburger when
  // it closes — a keyboard user is otherwise stranded behind the scrim. The
  // `wasOpen` guard keeps the initial render (drawer never opened) from
  // stealing focus to the hamburger on page load.
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (drawerOpen) {
      drawerWasOpen.current = true;
      drawerRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      hamburgerRef.current?.focus();
    }
  }, [drawerOpen]);

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

  const admin = (me.data?.grants.length ?? 0) > 0;
  const categories = buildNav(pluginLinks, { admin });

  usePageTitle(categories);

  // /api/auth/me carries neither rank nor location; both are derived from the
  // list endpoints, which is why the HUD depends on three queries.
  const rank = me.data ? progressToNextRank(me.data.exp, ranks.data?.ranks ?? []) : null;
  const here = locations.data?.locations.find((location) => location.current);

  // Neither endpoint reports a count, so both lists are counted here. They are
  // held by the shell rather than the pages so a badge moves on the WS
  // invalidation while the player is somewhere else entirely — which is the
  // only reason to have a badge at all.
  //
  // Plugin-supplied counts (`menu.badges` / core.ts applier) are keyed by the
  // literal path a subscriber wrote — `/plugins/<pageId>` for a plugin page —
  // so they merge into the same lookup the core categories use, and spread
  // first: the two core paths above are the ones this shell actually computes,
  // and keep that meaning even if a plugin ever collided on one of them.
  const pluginBadges: Readonly<Record<string, number>> = Object.fromEntries(
    (menuBadges.data?.badges ?? []).map((badge) => [badge.path, badge.count]),
  );
  const badges: Readonly<Record<string, number>> = {
    ...pluginBadges,
    "/mail": unreadCount(mail.data?.mail ?? []),
    "/notifications": (notifications.data?.notifications ?? [])
      .filter((notification) => notification.readAt === null).length,
  };

  return (
    <FormatProvider>
      <div className={styles.shell}>
        <a href="#main" className={styles.skipLink}>Skip to content</a>
        <header className={styles.header}>
          <button
            ref={hamburgerRef}
            type="button"
            className={styles.hamburger}
            aria-expanded={drawerOpen}
            aria-controls="app-drawer"
            aria-label="Menu"
            onClick={() => { setDrawerOpen(true); }}
          >
            <span /><span /><span />
          </button>
          <h1 className={styles.brand}>GL3</h1>
          <div className={styles.hud}>
            <div className={styles.hudGroup}>
              <Stat label="Cash">{me.data ? <Money value={me.data.cash} /> : "—"}</Stat>
              <Stat label="Bank">{me.data ? <Money value={me.data.bank} /> : "—"}</Stat>
            </div>
            <div className={styles.hudGroup}>
              <Stat label="Bullets">{me.data ? <Amount value={me.data.bullets} /> : "—"}</Stat>
              <Stat label="Points">{me.data ? <Amount value={me.data.points} /> : "—"}</Stat>
            </div>
            <div className={styles.hudGroup}>
              <Stat label="Rank">{rank?.current?.name ?? "Unranked"}</Stat>
              <Stat label="Location">{here?.name ?? "Nowhere"}</Stat>
            </div>
            {(hudExtras.data?.entries ?? []).length > 0 ? (
              <div className={styles.hudGroup}>
                {(hudExtras.data?.entries ?? []).map((entry) => (
                  <Stat key={`${entry.pluginId}:${entry.label}`} label={entry.label}>
                    {entry.countdownTo !== undefined
                      ? <CountdownValue to={entry.countdownTo} />
                      : entry.value}
                  </Stat>
                ))}
              </div>
            ) : null}
          </div>
          {/* The phone's condensed HUD: cash plus rank·location, one line each.
              The full hud above is display:none at that width. */}
          <div className={styles.miniHud}>
            <span className={styles.miniCash}>{me.data ? <Money value={me.data.cash} /> : "—"}</span>
            <span className={styles.miniSub}>{rank?.current?.name ?? "Unranked"} · {here?.name ?? "Nowhere"}</span>
          </div>
          <div ref={accountRef} className={styles.account}>
            <button
              type="button"
              className={styles.accountChip}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              onClick={() => { setAccountOpen(!accountOpen); }}
            >
              <span className={styles.accountDot} aria-hidden="true" />
              {me.data?.username ?? "—"}
            </button>
            {accountOpen ? (
              <div className={styles.accountMenu} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  disabled={logout.isPending}
                  onClick={() => { logout.mutate(); }}
                >
                  Log out
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {/*
          The nav itself lives in NavMenu: one component, three shapes — the
          top category bar (default), the left accordion sidebar
          ([data-nav="left"]), and the copy inside the phone drawer below. The
          slot class Shell passes only positions it on the page.
        */}
        <NavMenu
          categories={categories}
          badges={badges}
          activeKey={activeKey}
          className={styles.navSlot}
        />

        {drawerOpen ? (
          <>
            <div className={styles.scrim} onClick={() => { setDrawerOpen(false); }} />
            <div
              id="app-drawer"
              ref={drawerRef}
              className={styles.drawer}
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              tabIndex={-1}
              onClick={(event) => {
                // Close on navigation, not on every tap: a category header
                // toggle inside the drawer is a button, and must not slam the
                // drawer shut on the player mid-browse.
                if ((event.target as HTMLElement).closest("a") !== null) setDrawerOpen(false);
              }}
            >
              <div className={styles.drawerHead}>
                <span className={styles.drawerAvatar} aria-hidden="true">
                  {(me.data?.username ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <span className={styles.drawerWho}>
                  <b>{me.data?.username ?? "—"}</b>
                  <span className={styles.drawerSub}>
                    {me.data ? <Amount value={me.data.bullets} /> : "—"} bullets · {rank?.current?.name ?? "Unranked"}
                  </span>
                </span>
              </div>
              <NavMenu
                categories={categories}
                badges={badges}
                activeKey={activeKey}
                variant="drawer"
              />
              <button
                type="button"
                className={styles.drawerLogout}
                disabled={logout.isPending}
                onClick={() => { logout.mutate(); }}
              >
                Log out
              </button>
            </div>
          </>
        ) : null}

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
    </FormatProvider>
  );
}
