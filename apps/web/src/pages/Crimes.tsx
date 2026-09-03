import { useEffect } from "react";
import { refusalCooldownSeconds, useCountdowns, ApiError, useCommitCrime, useCrimes, useJail } from "@gl3/client";
import { CooldownButton, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./Crimes.module.css";
import { GameImage } from "../components/GameImage.js";

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

  // Re-anchor to the server's point-in-time snapshot on every refetch. seed()
  // ignores a 0, so the pre-commit snapshot still in flight can't unlock the
  // timer we started on commit, but a real disagreement wins — the server owns
  // the cooldown. Any row carries the value; take the largest to be safe.
  //
  // `dataUpdatedAt` is when that snapshot was read, and it matters because this
  // effect also runs on remount against the *cached* response: navigating away
  // and back re-seeded a stale reading as if it were fresh, restarting the
  // cooldown at full length on screen until the refetch corrected it.
  useEffect(() => {
    const rows = crimes.data?.crimes ?? [];
    const snapshot = rows.reduce((max, crime) => Math.max(max, crime.cooldownRemaining), 0);
    seed(COOLDOWN_ID, snapshot, crimes.dataUpdatedAt);
  }, [crimes.data, crimes.dataUpdatedAt, seed]);

  if (crimes.isLoading) return <Loading what="crimes" />;

  return (
    <Panel title="Crimes">
      <p className={styles.hint}>
        Crime success rate is based on different formulas and changes with your progression.
      </p>
      {jailed ? <p className={styles.note}>You can't commit crimes from jail.</p> : null}
      <ul className={styles.crimeList}>
        {crimes.data?.crimes.map((crime) => (
          <li key={crime.id} className={styles.crime}>
            <GameImage url={crime.imageUrl} alt={crime.name} size="md" />
            <div className={styles.crimeGrow}>
              <strong>{crime.name}</strong>
              {crime.description ? <div className={styles.meta}>{crime.description}</div> : null}
              <div className={styles.meta}>
                {crime.chance === null ? "chance by stats" : `${crime.chance}%`} ·{" "}
                <Money value={crime.minPayout} />–<Money value={crime.maxPayout} />{" "}
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
                    // The optimistic guess was wrong — take the server's
                    // number, and RELEASE the lock on a refusal that never
                    // burned the cooldown (insufficient_brave and friends):
                    // a dead button beside no message read as no feedback.
                    const seconds = refusalCooldownSeconds(error);
                    if (seconds !== null) start(COOLDOWN_ID, seconds);
                    if (error instanceof ApiError) void jail.refetch();
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
