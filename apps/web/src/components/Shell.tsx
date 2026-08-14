import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  useJail, useLocations, useLogout, useMail, useMe, useNotifications, usePlugins, useRanks,
} from "../api/queries.js";
import { useSentenceCountdown } from "../hooks/useSentenceCountdown.js";
import { formatDuration } from "../lib/errors.js";
import { unreadCount } from "../lib/mail.js";
import { progressToNextRank } from "../lib/ranks.js";
import { EventFeed } from "./EventFeed.js";
import { Amount, Money } from "./ui.js";
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
  ["/oc", "Heists"],
  ["/ranks", "Ranks"],
  ["/leaderboards", "Leaderboards"],
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
  );

  // `order` is the only thing that field is for, so the nav is the one place it
  // has to be honoured. Sorted on a copy — the array belongs to the query cache
  // — and tie-broken on pageId so two entries sharing an order stay put across
  // refetches instead of swapping places.
  const pluginLinks = [...(plugins.data?.menu ?? [])]
    .sort((a, b) => a.order - b.order || a.pageId.localeCompare(b.pageId));

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
              {unread > 0 ? <span className={styles.badge}>{unread}</span> : null}
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
        <main className={styles.content}>
          <Outlet />
        </main>
        <EventFeed />
      </div>
    </div>
  );
}
