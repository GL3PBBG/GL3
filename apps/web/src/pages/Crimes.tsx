import { useEffect } from "react";
import { useCommitCrime, useCrimes, useMe } from "../api/queries.js";
import { useCountdowns } from "../hooks/useCountdowns.js";
import { EventFeed } from "../components/EventFeed.js";
import styles from "./Crimes.module.css";

export function Crimes(): JSX.Element {
  const me = useMe();
  const crimes = useCrimes();
  const commit = useCommitCrime();
  const { remaining, seed, start } = useCountdowns();

  // Seed live countdowns from the server's point-in-time snapshot whenever the
  // crimes list refetches (initial load, and after a crime.resolved event —
  // see ws/useGameEvents). seed() ignores ids already ticking locally so a
  // refetch can't reset a timer we started on commit.
  useEffect(() => {
    for (const crime of crimes.data?.crimes ?? []) {
      seed(crime.id, crime.cooldownRemaining);
    }
  }, [crimes.data, seed]);

  if (crimes.isLoading || me.isLoading) return <p>Loading…</p>;

  return (
    <main className={styles.layout}>
      <section>
        <h2>{me.data?.username}</h2>
        <p>Cash: ${me.data?.cash} · Bank: ${me.data?.bank} · Exp: {me.data?.exp}</p>

        <ul className={styles.crimeList}>
          {crimes.data?.crimes.map((crime) => {
            const cooldown = remaining[crime.id] ?? 0;
            return (
              <li key={crime.id} className={styles.crime}>
                <div>
                  <strong>{crime.name}</strong>
                  <span> — {crime.chance}% · ${crime.minPayout}–${crime.maxPayout}</span>
                </div>
                <button
                  type="button"
                  disabled={cooldown > 0 || commit.isPending}
                  onClick={() => {
                    // Optimistically start the timer so the button locks the
                    // moment we commit, rather than waiting for the resolved
                    // event. The WS refetch re-seeds the accurate value.
                    start(crime.id, crime.cooldownSeconds);
                    commit.mutate(crime.id);
                  }}
                >
                  {cooldown > 0 ? `${cooldown}s` : "Commit"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <EventFeed />
    </main>
  );
}
