import { useEffect, useRef, useState } from "react";
import type { GameEvent } from "@gl3/shared";
import { refusalCooldownSeconds, useCountdowns, ApiError, useCommitCrime, useCrimes, useEvents, useJail, useMe } from "@gl3/client";
import { Amount, CooldownButton, ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import styles from "./Crimes.module.css";
import { GameImage } from "../components/GameImage.js";

/**
 * The crime cooldown is one Redis key per *player* (`cooldown:crime:<id>`, see
 * server game/crimes/routes.ts), not one per crime — `GET /api/crimes` merely
 * stamps that single value onto every row. Keying the countdown by crime id
 * therefore left the other buttons enabled and 429-ing. One id for all of them.
 */
const COOLDOWN_ID = "crime";

type CrimeResult = Extract<GameEvent, { type: "crime.resolved" }>;

export function CrimeOutcome({ result }: { result: CrimeResult }): JSX.Element {
  const calledOff = result.cause === "insufficient_pool";
  const caught = result.jailedUntil !== null;
  const tone = calledOff ? "neutral" : caught ? "caught" : result.success ? "success" : "failed";
  return <div className={styles.outcome} data-outcome={tone}>
    <span className={styles.outcomeIcon} aria-hidden="true">{calledOff ? "—" : caught ? "!" : result.success ? "$" : "×"}</span>
    <div className={styles.outcomeBody}>
      <span className={styles.eyebrow}>Job report · {result.crimeName}</span>
      <h3>{calledOff ? "Job called off" : caught ? result.success ? "Paid, but caught" : "Caught in the act" : result.success ? "Job pulled off" : "The job fell through"}</h3>
      <p>{calledOff ? "Your resources changed before the job could run. You couldn't cover the cost."
        : caught ? "The police caught up with you. Check jail for your release options."
        : result.success ? "You made your move and collected the take."
        : "This one didn't pay off. Regroup and choose your next move."}</p>
      <div className={styles.rewards}>
        <span><b>+<Money value={result.payout} /></b><small>Cash earned</small></span>
        <span><b>+<Amount value={result.exp} /></b><small>XP gained</small></span>
        {result.bullets !== "0" ? <span><b>+<Amount value={result.bullets} /></b><small>Bullets gained</small></span> : null}
      </div>
      {result.jailedUntil !== null ? <p className={styles.sentence}>Jailed until <When iso={result.jailedUntil} /></p> : null}
    </div>
  </div>;
}

export function Crimes(): JSX.Element {
  const crimes = useCrimes();
  const jail = useJail();
  const commit = useCommitCrime();
  const me = useMe();
  const events = useEvents();
  const seen = useRef(new Set(events.map((event) => event.id)));
  const [result, setResult] = useState<CrimeResult | null>(null);
  const [queuedCrime, setQueuedCrime] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ crimeId: string; error: Error } | null>(null);
  const { remaining, seed, start } = useCountdowns();

  // The POST only accepts a job. Only a fresh, confirmed event for this
  // player can reveal rewards; historical or other players' events cannot.
  useEffect(() => {
    const fresh = events.find((event): event is CrimeResult =>
      event.type === "crime.resolved" && event.actorId === me.data?.playerId && !seen.current.has(event.id));
    seen.current = new Set(events.map((event) => event.id));
    if (fresh) {
      setResult(fresh);
      setQueuedCrime((id) => id === fresh.crimeId ? null : id);
      setRefusal((current) => current?.crimeId === fresh.crimeId ? null : current);
    }
  }, [events, me.data?.playerId]);

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
            <div className={styles.crimeRow}>
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
                setResult(null);
                setRefusal(null);
                setQueuedCrime(crime.id);
                // Lock optimistically so the button reacts on click rather than
                // when the resolved event lands; the refetch re-seeds the truth.
                start(COOLDOWN_ID, crime.cooldownSeconds);
                commit.mutate(crime.id, {
                  onError: (error) => {
                    setQueuedCrime(null);
                    // Refusals never emit crime.resolved. Keep their message
                    // beside the attempted crime, where the player is looking.
                    setRefusal({ crimeId: crime.id, error });
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
            </div>
            <div aria-live="polite" aria-atomic="true">
              {result?.crimeId === crime.id ? <CrimeOutcome key={result.id} result={result} /> : null}
              {queuedCrime === crime.id ? <p className={styles.pending}>{commit.isPending ? "Making your move…" : "Job queued. Waiting for the outcome…"}</p> : null}
            </div>
            {refusal?.crimeId === crime.id ? <ErrorText error={refusal.error} /> : null}
          </li>
        ))}
      </ul>
      {result && !crimes.data?.crimes.some((crime) => crime.id === result.crimeId) ? <CrimeOutcome key={result.id} result={result} /> : null}
      {refusal && !crimes.data?.crimes.some((crime) => crime.id === refusal.crimeId) ? <ErrorText error={refusal.error} /> : null}
    </Panel>
  );
}
