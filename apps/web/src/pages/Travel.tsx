import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCountdowns, canAfford, formatDuration, refusalCooldownSeconds, useBrothelAvailability, useJail, useLocations, useMe, usePlugins, useTravel } from "@gl3/client";
import type { LocationDto } from "@gl3/shared";
import { Amount, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import { GameImage, useSlotImage } from "../components/GameImage.js";
import styles from "./Travel.module.css";

const COOLDOWN_ID = "travel";
const JOURNEY_REVEAL_MS = 1800;

function CityArt({ location }: { location: LocationDto }): JSX.Element {
  return <div className={styles.art}>
    <svg className={styles.skyline} viewBox="0 0 600 180" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <path d="M0 180V110h55V65h45v65h30V90h35V40h60v140h25V75h25V25h8V10h4v15h8v50h25v105h30V95h50v35h25V55h55v65h45V85h40v45h35v50Z" fill="currentColor" />
      <path d="M68 80h18m-18 16h18m94-40h30m-30 18h30m-30 18h30m150 18h25m73-40h28m-28 18h28m-28 18h28" stroke="var(--accent)" strokeWidth="3" opacity=".35" />
    </svg>
    <GameImage key={location.imageUrl ?? location.id} url={location.imageUrl} alt={location.name} size="banner" />
  </div>;
}

export function Travel(): JSX.Element {
  const me = useMe();
  const jail = useJail();
  const locations = useLocations();
  const plugins = usePlugins();
  const installed = plugins.data?.installed ?? [];
  const has = (id: string) => installed.includes(id);
  const brothel = useBrothelAvailability(has("brothel"));
  const travel = useTravel();
  const { remaining, seed, start } = useCountdowns();
  const [attempt, setAttempt] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ locationId: string; error: unknown } | null>(null);
  const [arrival, setArrival] = useState<LocationDto | null>(null);
  const [journey, setJourney] = useState<{ from: string | null; to: LocationDto } | null>(null);
  // Resolve the admin's travel artwork ahead of a trip, without drawing a
  // second header. Missing artwork never delays the confirmed arrival.
  const journeyArt = useSlotImage("core", "page-travel");
  const headerRef = useRef<HTMLElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const cityHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusArrival = useRef(false);
  const finishJourney = useCallback(() => {
    if (!journey) return;
    focusArrival.current = document.activeElement === skipRef.current;
    setArrival(journey.to);
    setJourney(null);
  }, [journey]);
  useEffect(() => {
    if (!journey) return;
    skipRef.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(finishJourney, JOURNEY_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [journey, finishJourney]);
  useEffect(() => {
    if (journey || arrival) headerRef.current?.scrollIntoView?.({ block: "nearest" });
    if (arrival && focusArrival.current) {
      cityHeadingRef.current?.focus({ preventScroll: true });
      focusArrival.current = false;
    }
  }, [journey, arrival]);

  const cooldown = remaining[COOLDOWN_ID] ?? 0;
  useEffect(() => {
    seed(COOLDOWN_ID, Math.max(0, ...(locations.data?.locations ?? []).map((row) => row.cooldownRemaining)), locations.dataUpdatedAt);
  }, [locations.data, locations.dataUpdatedAt, seed]);

  if (!me.data && me.isError) return <Panel title="Travel"><ErrorText error={me.error} /></Panel>;
  if (locations.isLoading || !me.data) return <Loading what="locations" />;
  const rows = locations.data?.locations ?? [];
  const here = rows.find((row) => row.current);
  const player = me.data;
  const displayedCity = arrival ? rows.find(row => row.id === arrival.id) ?? arrival : here;
  const blocked = jail.data?.jailed ? "You can't travel from jail."
    : jail.isError ? "Your jail status is unavailable. Try again shortly."
    : !jail.data ? "Checking your status…" : null;
  const venue = (location: LocationDto) => has("brothel") && !brothel.isError && brothel.data !== undefined
    && location.minLevel >= brothel.data.townMinLevel;
  const canVisit = (location: LocationDto) => venue(location) && player.level >= (brothel.data?.minLevel ?? 0);
  const services = (location: LocationDto) => <div className={styles.services} aria-label={`Places in ${location.name}`}>
    {has("bullets") || has("theft") || venue(location) ? <span className={styles.placesLabel}>In town</span> : null}
    {has("bullets") ? <Link to="/plugins/bullets.index">Bullet shop →</Link> : null}
    {has("theft") ? <Link to="/plugins/theft.garage">Garage →</Link> : null}
    {canVisit(location) ? <Link to="/plugins/brothel.index">Brothel →</Link> : null}
    {venue(location) && !canVisit(location) ? <span>Brothel · visit at level {brothel.data?.minLevel}</span> : null}
  </div>;
  const facts = (location: LocationDto) => <>
    <span className={styles.mode}>{location.combatMode === "underground" ? "Underground combat" : "Open combat"}</span>
    {has("bullets") ? <p className={styles.meta}>Bullets <Money value={location.bulletCost} /> each · <Amount value={String(location.bulletStock)} /> in stock</p> : null}
  </>;

  return <>
    {journey ? <section ref={headerRef} className={styles.journey} aria-label="Travel journey"
      onKeyDown={(event) => { if (event.key === "Escape") finishJourney(); }}>
      <div className={styles.journeyArt} aria-hidden="true">
        <GameImage key={journeyArt ?? "journey"} url={journeyArt ?? undefined} alt="" size="banner" zoomable={false} />
      </div>
      <div className={styles.journeyBody}>
        <span className={styles.eyebrow}>On the road</span>
        <div role="status"><p>{journey.from ? `Leaving ${journey.from}` : "A new chapter begins"}</p><h1>Next stop: {journey.to.name}</h1></div>
        <div className={styles.routeLine} aria-hidden="true"><span /></div>
        <button ref={skipRef} type="button" onClick={finishJourney}>Skip journey →</button>
      </div>
    </section> : displayedCity ? <section ref={headerRef} className={`${styles.hero} ${arrival ? styles.arrived : ""}`} aria-label="Current city">
      <CityArt location={displayedCity} />
      <div className={styles.heroBody}>
        <div role={arrival ? "status" : undefined} aria-label={arrival ? "Arrival confirmed" : undefined}>
          <span className={styles.eyebrow}>{arrival ? "Welcome to" : "You are here"}</span>{" "}
          <h1 ref={cityHeadingRef} tabIndex={-1}>{displayedCity.name}</h1>
        </div>
        {facts(displayedCity)}
        {services(displayedCity)}
      </div>
    </section> : null}
    <Panel title="Travel">
      <div className={styles.intro}>
        <div><h3>Choose your next city</h3><p className={styles.meta}>New streets. New opportunities.</p></div>
        <div className={styles.wallet}><span>Cash on hand</span><strong><Money value={player.cash} /></strong></div>
      </div>
      <p className={styles.readiness}>{blocked ? "Travel unavailable" : cooldown > 0 ? `Next trip in ${formatDuration(cooldown)}` : locations.isError || !rows.some(row => !row.current && row.minLevel <= player.level && canAfford(player.cash, row.travelCost)) ? "Explore destinations" : "Ready for your next trip"}<span>Travel is instant. Cooldown is the wait before your next trip.</span></p>
      {blocked ? <p className={styles.notice} role="status">{blocked}</p> : null}
      <ErrorText error={locations.error} />
      {has("brothel") && brothel.isError ? <p className={styles.meta}>Brothel availability is currently unavailable.</p> : null}
      {rows.length === 0 && !locations.isError ? <p className={styles.meta}>No destinations are available yet.</p> : null}
      <ul className={styles.grid}>
        {rows.map((location) => {
          const levelLocked = location.minLevel > player.level;
          const affordable = canAfford(player.cash, location.travelCost);
          const pending = travel.isPending && attempt === location.id;
          const state = location.current ? "You are here" : levelLocked ? `Unlocks at level ${location.minLevel}` : !affordable ? "Not enough cash" : "Available";
          return <li key={location.id} className={styles.card} data-current={location.current}>
            <CityArt location={location} />
            <div className={styles.body}>
              <span className={styles.badge}>{state}</span>
              <h3>{location.name}</h3>
              {facts(location)}
              <div className={styles.venues} aria-label={`Places in ${location.name}`}>
                {has("bullets") || has("theft") || venue(location) ? <span className={styles.placesLabel}>In town</span> : null}
                {has("bullets") ? <span>Bullet shop</span> : null}
                {has("theft") ? <span>Garage</span> : null}
                {venue(location) ? <span>Brothel{player.level < (brothel.data?.minLevel ?? 0) ? ` · visit at level ${brothel.data?.minLevel}` : ""}</span> : null}
              </div>
              <div className={styles.fare}>
                <span>Travel fare</span>
                <strong>{location.baseFare !== undefined ? <s><Money value={location.baseFare} /></s> : null}<Money value={location.travelCost} /></strong>
                {location.fareLabel ? <small>{location.fareLabel}</small> : null}
              </div>
              <p className={styles.meta}>{formatDuration(location.travelCooldownSeconds)} cooldown after arrival{location.minLevel > 0 ? ` · level ${location.minLevel}` : ""}</p>
              <button type="button" disabled={location.current || levelLocked || !affordable || blocked !== null || travel.isPending || journey !== null || cooldown > 0}
                onClick={() => {
                  setAttempt(location.id);
                  setRefusal(null);
                  setArrival(null);
                  start(COOLDOWN_ID, location.travelCooldownSeconds);
                  travel.mutate(location.id, {
                    onSuccess: (response) => {
                      const destination = rows.find((row) => row.id === response.locationId);
                      if (!destination) return;
                      // This is presentation after success, never a promise
                      // that an in-flight or refused request moved the player.
                      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setArrival(destination);
                      else setJourney({ from: here?.name ?? null, to: destination });
                    },
                    onError: (error) => {
                      setRefusal({ locationId: location.id, error });
                      const retry = refusalCooldownSeconds(error);
                      if (retry !== null) start(COOLDOWN_ID, retry);
                      void jail.refetch();
                    },
                  });
                }}>
                {location.current ? "Here" : pending ? "Travelling…" : levelLocked ? `Level ${location.minLevel} required` : !affordable ? "Not enough cash" : cooldown > 0 ? `Wait ${formatDuration(cooldown)}` : "Travel"}
              </button>
              {refusal?.locationId === location.id ? <ErrorText error={refusal.error} /> : null}
            </div>
          </li>;
        })}
      </ul>
      {refusal && !rows.some((row) => row.id === refusal.locationId) ? <ErrorText error={refusal.error} /> : null}
    </Panel>
  </>;
}
