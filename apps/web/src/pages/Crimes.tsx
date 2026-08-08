import { useEffect } from "react";
import { ApiError } from "../api/client.js";
import { useCommitCrime, useCrimes, useJail } from "../api/queries.js";
import { useCountdowns } from "../hooks/useCountdowns.js";
import { CooldownButton, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./Crimes.module.css";

/**
 * The crime cooldown is one Redis key per *player* (`cooldown:crime:<id>`, see
 * server game/crimes/routes.ts), not one per crime — `GET /api/crimes` merely
 * stamps that single value onto every row. Keying the countdown by crime id
 * therefore left the other buttons enabled and 429-ing. One id for all of them.
 */
const COOLDOWN_ID = "crime";

export function Crimes(): JSX.Element {
  const crimes = useCrimes();
  const jail = useJail();
  const commit = useCommitCrime();
  const { remaining, seed, start } = useCountdowns();

  const jailed = jail.data?.jailed === true;
  const cooldown = remaining[COOLDOWN_ID] ?? 0;

  // Seed from the server's point-in-time snapshot on every refetch. seed()
  // ignores an id already ticking locally, so a refetch can't reset a timer we
  // started on commit. Any row carries the value; take the largest to be safe.
  useEffect(() => {
    const rows = crimes.data?.crimes ?? [];
    const snapshot = rows.reduce((max, crime) => Math.max(max, crime.cooldownRemaining), 0);
    seed(COOLDOWN_ID, snapshot);
  }, [crimes.data, seed]);

  if (crimes.isLoading) return <Loading what="crimes" />;

  return (
    <Panel title="Crimes">
      {jailed ? <p className={styles.note}>You can't commit crimes from jail.</p> : null}
      <ul className={styles.crimeList}>
        {crimes.data?.crimes.map((crime) => (
          <li key={crime.id} className={styles.crime}>
            <div>
              <strong>{crime.name}</strong>
              <div className={styles.meta}>
                {crime.chance}% · <Money value={crime.minPayout} />–<Money value={crime.maxPayout} />{" "}
                · {crime.cooldownSeconds}s cooldown
              </div>
            </div>
            <CooldownButton
              label="Commit"
              seconds={cooldown}
              disabled={jailed || commit.isPending}
              onClick={() => {
                // Lock optimistically so the button reacts on click rather than
                // when the resolved event lands; the refetch re-seeds the truth.
                start(COOLDOWN_ID, crime.cooldownSeconds);
                commit.mutate(crime.id, {
                  onError: (error) => {
                    // The optimistic guess was wrong — take the server's number.
                    if (!(error instanceof ApiError)) return;
                    if (error.retryAfter !== undefined) start(COOLDOWN_ID, error.retryAfter);
                    void jail.refetch();
                  },
                });
              }}
            />
          </li>
        ))}
      </ul>
      <ErrorText error={commit.error} />
    </Panel>
  );
}
