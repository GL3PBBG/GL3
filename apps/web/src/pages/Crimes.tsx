import { useCommitCrime, useCrimes, useMe } from "../api/queries.js";
import { EventFeed } from "../components/EventFeed.js";
import styles from "./Crimes.module.css";

export function Crimes(): JSX.Element {
  const me = useMe();
  const crimes = useCrimes();
  const commit = useCommitCrime();

  if (crimes.isLoading || me.isLoading) return <p>Loading…</p>;

  return (
    <main className={styles.layout}>
      <section>
        <h2>{me.data?.username}</h2>
        <p>Cash: ${me.data?.cash} · Bank: ${me.data?.bank} · Exp: {me.data?.exp}</p>

        <ul className={styles.crimeList}>
          {crimes.data?.crimes.map((crime) => (
            <li key={crime.id} className={styles.crime}>
              <div>
                <strong>{crime.name}</strong>
                <span> — {crime.chance}% · ${crime.minPayout}–${crime.maxPayout}</span>
              </div>
              <button
                type="button"
                disabled={crime.cooldownRemaining > 0 || commit.isPending}
                onClick={() => commit.mutate(crime.id)}
              >
                {crime.cooldownRemaining > 0 ? `${crime.cooldownRemaining}s` : "Commit"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <EventFeed />
    </main>
  );
}
