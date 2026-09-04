import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useSentenceCountdown, secondsLeft, facilityArrival, type FacilityState, formatDuration, unreadCount, buildNav, labelForPath, navKeyFor, type NavCategory, rankProgress, useHospital, useHudExtras, useJail, useLocations, useLogout, useMail, useMe, useMenuBadges, useNotifications, usePlugins, useRanks } from "@gl3/client";
import { FormatProvider } from "../lib/formatContext.js";
import { bannerSlotFor } from "../lib/pageBanners.js";
import { BrandMark, useBranding } from "./BrandMark.js";
import { EventFeed } from "./EventFeed.js";
import { EventToasts } from "./EventToasts.js";
import { Meter } from "./Meter.js";
import { HudIcon } from "./HudIcon.js";
import { NavMenu } from "./NavMenu.js";
import { Amount, Money } from "./ui.js";
import { SlotImage } from "./GameImage.js";
import styles from "./Shell.module.css";
import type { PlayerAttributesDto } from "@gl3/shared";

/**
 * Pool bars for whichever of the three attribute pools `/api/auth/me`
 * carries — absent entirely on an install with no attribute plugin loaded
 * (see `PlayerAttributesDtoSchema`), which is what keeps a v2 boot's HUD
 * byte-identical to before this feature existed.
 */
function PoolBars({ attributes }: { attributes: PlayerAttributesDto }): JSX.Element {
  const pools: readonly [string, string, number, number][] = [
    ["energy", "Energy", attributes.energy, attributes.energyMax],
    ["will", "Will", attributes.will, attributes.willMax],
    ["brave", "Brave", attributes.brave, attributes.braveMax],
  ];
  return (
    <div className={styles.hudGroup}>
      {pools.map(([icon, label, value, max]) => (
        <span key={icon} className={styles.stat}>
          <HudIcon id={icon} />
          <Meter label={label} value={value} max={max} compact />
        </span>
      ))}
    </div>
  );
}

/**
 * One HUD stat: a glyph, the value, and the label demoted to a tooltip plus
 * visually-hidden text — a screen reader hears "Cash $209,980" exactly as
 * the old text HUD read, while the strip fits one line. An `icon` the glyph
 * table doesn't know renders nothing and the label text stands alone, so a
 * plugin-supplied entry never loses its meaning to a missing picture.
 */
function Stat({ icon, label, children }: { icon?: string; label: string; children: ReactNode }): JSX.Element {
  return (
    <span className={styles.stat} title={label}>
      {icon !== undefined ? <HudIcon id={icon} /> : null}
      <span className={icon !== undefined ? styles.srOnly : styles.statLabel}>{label}</span>
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


function PageBanner(): JSX.Element | null {
  const { pathname } = useLocation();
  // Exact pathname first — required for /plugins/<pageId> routes, which all
  // share a first segment of "/plugins" — then a first-segment fallback, so
  // `/mail/:threadId` still shares the mail list's banner. See pageBanners.ts.
  const banner = bannerSlotFor(pathname);
  if (banner === null) return null;
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
  // it, and the title must catch up when it does. The game name arrives the
  // same way (the theme fetch), through the branding store subscription.
  const { gameName } = useBranding();
  const label = labelForPath(categories, pathname);
  const title = label === undefined ? gameName : `${label} — ${gameName}`;
  useEffect(() => { document.title = title; }, [title]);
}

export function Shell(): JSX.Element {
  const me = useMe();
  const jail = useJail();
  const hospital = useHospital();
  const ranks = useRanks();
  const locations = useLocations();
  const logout = useLogout();
  const mail = useMail();
  const notifications = useNotifications();
  const plugins = usePlugins();
  const installed = plugins.data?.installed;
  const showBullets = installed === undefined || installed.includes("combat") || installed.includes("bullets");
  const showLocation = installed === undefined || installed.includes("travel");
  const hudExtras = useHudExtras();
  const menuBadges = useMenuBadges();

  const { pathname } = useLocation();
  const activeKey = navKeyFor(pathname);

  // Landing in jail or hospital moves the player to that page. Keyed off the
  // queries' `false → true` flip rather than any event, because every route
  // into either facility invalidates these queries and not all of them
  // publish — see facilityRedirect.ts. The ref holds the last seen state so a
  // refetch that changes nothing (the sentence poll) never re-navigates.
  const navigate = useNavigate();
  const jailed = jail.data?.jailed;
  const hospitalised = hospital.data?.hospitalised;
  const lastFacility = useRef<FacilityState>({ jailed, hospitalised });
  useEffect(() => {
    const next: FacilityState = { jailed, hospitalised };
    const target = facilityArrival(lastFacility.current, next);
    lastFacility.current = next;
    if (target !== null && target !== pathname) navigate(target);
  }, [jailed, hospitalised, pathname, navigate]);

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
  // list endpoints, which is why the HUD depends on three queries. Which
  // derivation — exp thresholds, or level as an ordinal rung — is the
  // plugins payload's `progression`: on a routed boot `exp` is within-level
  // exp and reading thresholds off it showed the bottom rank to everyone.
  const rank = me.data ? rankProgress(plugins.data?.progression, me.data, ranks.data?.ranks ?? []) : null;
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
          <BrandMark variant="header" className={styles.brand} />
          <div className={styles.hud}>
            <div className={styles.hudGroup}>
              <Stat icon="cash" label="Cash">{me.data ? <Money value={me.data.cash} /> : "—"}</Stat>
              <Stat icon="bank" label="Bank">{me.data ? <Money value={me.data.bank} /> : "—"}</Stat>
            </div>
            {/* Feature detection via the plugins payload: a stat whose
                owning plugin is absent (framework boot: no combat, no
                travel) would be a permanent zero/Nowhere readout. Undefined
                while the payload loads — show, then hide if absent. */}
            <div className={styles.hudGroup}>
              {showBullets ? <Stat icon="bullet" label="Bullets">{me.data ? <Amount value={me.data.bullets} /> : "—"}</Stat> : null}
              <Stat icon="points" label="Points">{me.data ? <Amount value={me.data.points} /> : "—"}</Stat>
            </div>
            {/* Health rides its own group ahead of the pools: every profile
                has it (combat whittles it), and it must not disappear with
                the attribute family. Optional-chained for an older server
                whose payload predates the field. */}
           <div className={styles.hudGroup}>
            {me.data?.health !== undefined && me.data.healthMax !== undefined ? (
            
                <span className={styles.stat}>
                  <HudIcon id="health" />
                  <Meter label="Health" value={me.data.health} max={me.data.healthMax} compact />
                </span>
            ) : null}
             
            {me.data?.attributes ? <PoolBars attributes={me.data.attributes} /> : null}
            </div>
          </div>
          {/* The phone's condensed HUD: cash plus rank·location, one line each.
              The full hud above is display:none at that width. */}
          <div className={styles.miniHud}>
            <span className={styles.miniCash}>{me.data ? <Money value={me.data.cash} /> : "—"}</span>
            <span className={styles.miniSub}>
              {rank?.current?.name ?? "Unranked"}{showLocation ? ` · ${here?.name ?? "Nowhere"}` : ""}
            </span>
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
        {/*
          The header carries only what moves while you play — money, ammo,
          pools. Everything slower lives on the nav row's right-hand side as a
          status line: rank, town, and the plugin-supplied countdowns whose
          labels are any length a plugin likes. Splitting by tempo is what
          keeps the sticky strip one line; the ellipsis on the extras is what
          keeps a long label from ever breaking it. In sidebar mode the row
          dissolves (display: contents) and the status line takes its own grid
          area under the header — see Shell.module.css.
        */}
        <div className={styles.navRow}>
          <NavMenu
            categories={categories}
            badges={badges}
            activeKey={activeKey}
            className={styles.navSlot}
          />
          <div className={styles.status}>
            <span className={styles.statusCore}>
              <Stat icon="rank" label="Rank">{rank?.current?.name ?? "Unranked"}</Stat>
              {showLocation ? <Stat icon="location" label="Location">{here?.name ?? "Nowhere"}</Stat> : null}
            </span>
            {(hudExtras.data?.entries ?? []).length > 0 ? (
              <span className={styles.statusExtras}>
                {(hudExtras.data?.entries ?? []).map((entry) => (
                  <Stat key={`${entry.pluginId}:${entry.label}`} icon="clock" label={entry.label}>
                    <span className={styles.clip}>
                      {entry.countdownTo !== undefined
                        ? <CountdownValue to={entry.countdownTo} />
                        : entry.value}
                    </span>
                  </Stat>
                ))}
              </span>
            ) : null}
          </div>
        </div>

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
        <EventToasts />
      </div>
    </FormatProvider>
  );
}
