import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { canAfford, useSentenceCountdown, formatDuration, rankProgress, renderNode, useCrimes, useDashboardWidgets, useHospital, useJail, useLocations, useMe, usePlugins, useProfile, useRanks } from "@gl3/client";
import { Amount, Avatar, Loading, Money, Panel } from "../components/ui.js";
import { GameImage } from "../components/GameImage.js";
import { HudIcon } from "../components/HudIcon.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import styles from "./Dashboard.module.css";

/**
 * Whether the dashboard must draw a widget's titled frame itself. A `panel`
 * view already becomes one through renderNode → groupIntoPanels (the same
 * path PluginPage takes), so framing it again nests two same-titled panels —
 * "Crimes > Crimes", seen live 2026-09-05. Only a bare leaf needs the frame.
 */
export function widgetNeedsFrame(view: unknown): boolean {
  // `view` is `unknown` on the wire (ViewNodeDtoSchema is a lazy schema);
  // renderNode does its own shape checks, this only needs the root kind.
  return !(typeof view === "object" && view !== null && (view as { kind?: unknown }).kind === "panel");
}

function Identity({ playerId, username, rank }: { playerId: string; username: string; rank: string }): JSX.Element {
  const profile = useProfile(playerId);
  return <div className={styles.identity}>
    <Link to="/profile" className={styles.portrait} aria-label="Your profile">
      <span aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span>
      <Avatar key={profile.data?.avatarUrl ?? "default"} url={profile.data?.avatarUrl ?? null} alt={`${username}'s portrait`} />
    </Link>
    <div className={styles.identityText}>
      <span className={styles.eyebrow}>Your headquarters</span>
      <h1>{username}</h1>
      <p>{rank}{profile.data?.gangName ? ` · ${profile.data.gangName}` : ""}</p>
    </div>
  </div>;
}

function ActionCard({ to, icon, title, status, children, ready = false }: {
  to: string; icon: string; title: string; status: string; children: ReactNode; ready?: boolean;
}): JSX.Element {
  return <Link to={to} className={styles.action}>
    <div className={styles.actionTop}><HudIcon id={icon} /><span className={ready ? styles.ready : styles.status}>{status}</span></div>
    <strong>{title}</strong><p>{children}</p><span className={styles.actionArrow} aria-hidden="true">↗</span>
  </Link>;
}

function CrimeAction({ blocked }: { blocked: string | null }): JSX.Element {
  const crimes = useCrimes();
  const rows = crimes.data?.crimes ?? [];
  const seconds = useSentenceCountdown("crime", Math.max(0, ...rows.map((row) => row.cooldownRemaining)), crimes.dataUpdatedAt);
  const status = blocked ?? (crimes.isError ? "Status unavailable" : !crimes.data ? "Checking jobs…"
    : rows.length === 0 ? "No jobs available" : seconds > 0 ? `Wait ${formatDuration(seconds)}` : "Cooldown ready");
  return <ActionCard to="/plugins/crimes.index" icon="brave" title="Work the streets" status={status}
    ready={blocked === null && !!crimes.data && rows.length > 0 && seconds === 0 && !crimes.isError}>
    Choose a job, weigh the risk, and collect the take.
  </ActionCard>;
}

export function Dashboard(): JSX.Element {
  const me = useMe();
  const plugins = usePlugins();
  const jail = useJail();
  const hospital = useHospital();
  const ranks = useRanks();
  const locations = useLocations();
  const widgets = useDashboardWidgets();
  const jailSeconds = useSentenceCountdown("jail", jail.data?.jailed ? jail.data.remainingSeconds : undefined, jail.dataUpdatedAt);
  const hospitalSeconds = useSentenceCountdown("hospital", hospital.data?.hospitalised ? hospital.data.remainingSeconds : undefined, hospital.dataUpdatedAt);
  const travelSeconds = useSentenceCountdown("travel", Math.max(0, ...(locations.data?.locations ?? []).map((row) => row.cooldownRemaining)), locations.dataUpdatedAt);

  if (!me.data) return <Loading />;

  const player = me.data;
  const installed = plugins.data?.installed ?? [];
  const has = (id: string) => installed.includes(id);
  const level = plugins.data?.progression === "level";
  const ladder = ranks.data?.ranks ?? [];
  const progress = rankProgress(plugins.data?.progression, player, ladder);
  const here = locations.data?.locations.find((location) => location.current);
  const nextCity = has("travel") ? locations.data?.locations.filter((location) => location.minLevel > player.level)
    .sort((a, b) => a.minLevel - b.minLevel || a.name.localeCompare(b.name))[0] : undefined;
  const destination = locations.data?.locations.some((location) => !location.current && location.minLevel <= player.level && canAfford(player.cash, location.travelCost));
  const jailed = jail.data?.jailed === true;
  const hospitalised = hospital.data?.hospitalised === true;
  // Unknown facility state must never advertise an action as ready.
  const blocked = jailed ? "In jail" : hospitalised ? "In hospital"
    : jail.isError || hospital.isError ? "Status unavailable" : !jail.data || !hospital.data ? "Checking status…" : null;
  const travelStatus = blocked ?? (locations.isError ? "Status unavailable" : !locations.data ? "Checking routes…"
    : travelSeconds > 0 ? `Wait ${formatDuration(travelSeconds)}` : destination ? "Ready to travel" : "View destinations");

  return <>
    <section className={styles.headquarters} aria-label="Your headquarters">
      <div className={styles.cityBackdrop} aria-hidden="true">
        {has("travel") && here?.imageUrl ? <GameImage key={here.imageUrl} url={here.imageUrl} alt="" size="banner" zoomable={false} /> : null}
      </div>
      <div className={styles.heroContent}>
        <div className={styles.heroTop}>
          <Identity playerId={player.playerId} username={player.username} rank={progress.current?.name ?? "Unranked"} />
          {has("travel") ? <Link to="/plugins/travel.index" className={styles.location}><HudIcon id="location" />{here?.name ?? "Choose your city"}</Link> : null}
        </div>
        <div className={styles.balances}>
          <div><span>Cash on hand</span><strong><Money value={player.cash} /></strong></div>
          {has("bank") ? <div><span>In the bank</span><strong><Money value={player.bank} /></strong></div> : null}
          {has("bullets") ? <div><span>Bullets</span><strong><Amount value={player.bullets} /></strong></div> : null}
          <div><span>{level ? `Level ${player.level} · XP` : "Experience"}</span><strong><Amount value={player.exp} /></strong></div>
        </div>
      </div>
    </section>

    {jailed || hospitalised ? <div className={styles.facility} role="status">
      <HudIcon id="clock" />
      <div>{jailed ? <>In jail · {formatDuration(jailSeconds)} remaining. <Link to="/plugins/jail">View release options</Link></> : null}
        {jailed && hospitalised ? <br /> : null}
        {hospitalised ? <>In hospital · {formatDuration(hospitalSeconds)} remaining. <Link to="/plugins/hospital">View recovery options</Link></> : null}</div>
    </div> : null}

    <div className={styles.overview}>
      <Panel title="Your next milestone">
        {!ranks.data ? <p className={styles.meta}>{ranks.isError ? "Rank progress is unavailable." : "Loading rank progress…"}</p>
          : ladder.length === 0 ? <p className={styles.meta}>Your story is just beginning. Explore the activities below.</p>
          : <>
            <div className={styles.rankHeading}>
              {progress.next?.imageUrl || progress.current?.imageUrl ? <GameImage key={progress.next?.imageUrl ?? progress.current?.imageUrl} url={progress.next?.imageUrl ?? progress.current?.imageUrl} alt={`${progress.next?.name ?? progress.current?.name} badge`} size="md" /> : <span className={styles.rankIcon}><HudIcon id="rank" /></span>}
              <div><span className={styles.eyebrow}>{progress.next ? "Next rank" : "Top rank reached"}</span><h3>{progress.next?.name ?? progress.current?.name}</h3></div>
            </div>
            {level ? <p className={styles.meta}>{progress.next ? `Unlocks at level ${progress.next.levelRequired ?? player.level + 1}. You are level ${player.level}.` : `Level ${player.level} · You've reached the top of the rank ladder.`}</p>
              : <>
                <div className={styles.progress} role="progressbar" aria-label="Rank progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}>
                  <div style={{ width: `${progress.pct}%` }} />
                </div>
                <p className={styles.meta}>{progress.next ? <><Amount value={(BigInt(progress.next.expRequired) - BigInt(player.exp)).toString()} /> XP to go · {progress.pct.toFixed(1)}%</> : "You've reached the top of the rank ladder."}</p>
              </>}
            <Link to="/ranks">Explore the rank ladder →</Link>
          </>}
      </Panel>
      {has("travel") ? <Panel title="Your city">
        <span className={styles.eyebrow}>On your doorstep</span>
        <h3 className={styles.cityName}>{here?.name ?? "A new beginning"}</h3>
        {locations.isError ? <p className={styles.meta}>City information is unavailable.</p> : !locations.data ? <p className={styles.meta}>Loading your city…</p> : here ? <>
          <p className={styles.meta}>{here.combatMode === "underground" ? "Underground combat district" : "Your current base of operations"}</p>
          {has("bullets") ? <p className={styles.cityStock}>Bullets <Money value={here.bulletCost} /> each · <Amount value={String(here.bulletStock)} /> in stock. <Link to="/plugins/bullets.index">Visit the bullet shop</Link></p> : null}
        </> : <p className={styles.meta}>Pick a city and establish your base of operations.</p>}
        {nextCity ? <div className={styles.unlock}><HudIcon id="location" /><span>Next city unlock <b>{nextCity.name}</b> at level {nextCity.minLevel}</span></div> : null}
        <Link to="/plugins/travel.index">Explore destinations →</Link>
      </Panel> : null}
    </div>

    <section className={styles.moves} aria-labelledby="next-moves">
      <div className={styles.sectionHeading}><h2 id="next-moves">Make your next move</h2><span>Build your name. Grow your empire.</span></div>
      <div className={styles.actions}>
        {has("crimes") ? <CrimeAction blocked={blocked} /> : null}
        {has("travel") ? <ActionCard to="/plugins/travel.index" icon="location" title="Change the scenery" status={travelStatus} ready={travelStatus === "Ready to travel"}>Find your next city and see what it has to offer.</ActionCard> : null}
        {has("bank") ? <ActionCard to="/bank" icon="bank" title="Secure your earnings" status={BigInt(player.cash) > 0n ? "Cash on hand" : "View account"}>Manage your balance and bank your take.</ActionCard> : null}
        <ActionCard to="/leaderboards" icon="rank" title="Check the competition" status="Leaderboards">See who's ahead and find your next rival.</ActionCard>
      </div>
    </section>

    {(widgets.data?.widgets ?? []).map((widget) => {
      const key = `${widget.pluginId}:${widget.title}`;
      const body = <PageRenderer instructions={renderNode(widget.view, {})} />;
      return widgetNeedsFrame(widget.view)
        ? <Panel key={key} title={widget.title}>{body}</Panel>
        : <Fragment key={key}>{body}</Fragment>;
    })}
  </>;
}
