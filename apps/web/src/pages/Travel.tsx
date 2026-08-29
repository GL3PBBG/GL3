import { useEffect } from "react";
import { ApiError } from "../api/client.js";
import { useJail, useLocations, useMe, useTravel } from "../api/queries.js";
import { useCountdowns } from "../hooks/useCountdowns.js";
import { canAfford } from "../lib/money.js";
import { CooldownButton, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";
import { GameImage } from "../components/GameImage.js";

/** Same shape as crimes: `cooldown:travel:<playerId>` is one key per player. */
const COOLDOWN_ID = "travel";

export function Travel(): JSX.Element {
  const me = useMe();
  const jail = useJail();
  const locations = useLocations();
  const travel = useTravel();
  const { remaining, seed, start } = useCountdowns();

  const jailed = jail.data?.jailed === true;
  const cooldown = remaining[COOLDOWN_ID] ?? 0;

  // Same shape as Crimes, including the anchor: `dataUpdatedAt` keeps a cached
  // snapshot served on remount from restarting the cooldown at full length.
  useEffect(() => {
    const rows = locations.data?.locations ?? [];
    seed(
      COOLDOWN_ID,
      rows.reduce((max, row) => Math.max(max, row.cooldownRemaining), 0),
      locations.dataUpdatedAt,
    );
  }, [locations.data, locations.dataUpdatedAt, seed]);

  if (locations.isLoading || !me.data) return <Loading what="locations" />;
  const cash = me.data.cash;

  return (
    <Panel title="Travel">
      {jailed ? <p className={styles.bad}>You can't travel from jail.</p> : null}
      <ul className={styles.rows}>
        {locations.data?.locations.map((location) => {
          const affordable = canAfford(cash, location.travelCost);
          // The town's level lock rides the same row: visible as a teaser
          // (the requirement), and the button is dead below it rather than
          // letting the POST 409 after the fact.
          const levelLocked = location.minLevel > (me.data?.level ?? 1);
          return (
            <li
              key={location.id}
              className={location.current ? `${styles.row} ${styles.rowCurrent}` : styles.row}
            >
              <GameImage url={location.imageUrl} alt={location.name} size="md" />
              <div className={styles.rowGrow}>
                <strong>{location.name}</strong>
                {location.current ? <span className={styles.meta}> · you are here</span> : null}
                <div className={styles.meta}>
                  <Money value={location.travelCost} /> · {location.travelCooldownSeconds}s cooldown ·
                  bullets <Money value={location.bulletCost} /> ({location.bulletStock} in stock)
                  {location.combatMode === "underground" ? <> · underground</> : null}
                  {location.minLevel > 0 ? <> · level {location.minLevel}</> : null}
                </div>
              </div>
              {location.current ? (
                <button type="button" disabled>Here</button>
              ) : (
                <CooldownButton
                  label={levelLocked ? `Level ${location.minLevel}` : affordable ? "Travel" : "Too poor"}
                  seconds={cooldown}
                  disabled={jailed || levelLocked || !affordable || travel.isPending}
                  onClick={() => {
                    start(COOLDOWN_ID, location.travelCooldownSeconds);
                    travel.mutate(location.id, {
                      onError: (error) => {
                        if (!(error instanceof ApiError)) return;
                        if (error.retryAfter !== undefined) start(COOLDOWN_ID, error.retryAfter);
                        void jail.refetch();
                      },
                    });
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      <ErrorText error={travel.error} />
    </Panel>
  );
}
