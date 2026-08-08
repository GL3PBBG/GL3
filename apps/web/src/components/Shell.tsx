import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useJail, useLocations, useLogout, useMe, useRanks } from "../api/queries.js";
import { formatDuration } from "../lib/errors.js";
import { progressToNextRank } from "../lib/ranks.js";
import { EventFeed } from "./EventFeed.js";
import { Amount, Money } from "./ui.js";
import styles from "./Shell.module.css";

const LINKS: ReadonlyArray<readonly [string, string]> = [
  ["/", "Dashboard"],
  ["/crimes", "Crimes"],
  ["/jail", "Jail"],
  ["/bank", "Bank"],
  ["/travel", "Travel"],
  ["/bullets", "Bullets"],
  ["/ranks", "Ranks"],
  ["/leaderboards", "Leaderboards"],
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

  // /api/auth/me carries neither rank nor location; both are derived from the
  // list endpoints, which is why the HUD depends on three queries.
  const rank = me.data ? progressToNextRank(me.data.exp, ranks.data?.ranks ?? []) : null;
  const here = locations.data?.locations.find((location) => location.current);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.brand}>Gangster Legends</h1>
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
        {LINKS.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              isActive ? `${styles.navLink} ${styles.navActive}` : styles.navLink
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      {jail.data?.jailed === true ? (
        <p className={styles.jailBanner} role="status">
          In jail — {formatDuration(jail.data.remainingSeconds)} remaining.
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
