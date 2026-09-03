import { useEffect, useState } from "react";
import type { LeaderboardKind, RoundDto } from "@gl3/shared";
import { useMe, useRoundStandings, useRounds } from "../api/queries.js";
import { Amount, ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { useMoneyFormat } from "../lib/formatContext.js";
import { formatBoardScore } from "@gl3/client";
import styles from "./pages.module.css";

const KINDS: ReadonlyArray<readonly [LeaderboardKind, string]> = [
  ["cash", "Cash"],
  ["bank", "Bank"],
  ["exp", "Exp"],
];

/**
 * `secondsRemaining` is a snapshot from the last fetch, not a live clock — so
 * the page ticks it down locally between refetches rather than reprinting the
 * same number until the next poll. `null` (open-ended round) never ticks.
 */
export function formatCountdown(secondsRemaining: number | null): string {
  if (secondsRemaining === null) return "no end date";
  // Never a negative duration: a round whose deadline has passed but hasn't
  // been swept yet reads as over, not as "-4s".
  const total = Math.max(0, secondsRemaining);
  if (total === 0) return "ended";
  if (total >= 86_400) {
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    return `${days}d ${hours}h`;
  }
  if (total >= 3_600) {
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    return `${hours}h ${minutes}m`;
  }
  if (total >= 60) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}m ${seconds}s`;
  }
  return `${total}s`;
}

/**
 * Newest-first by `endsAt`, open-ended rounds last (a finished round can be
 * open-ended if it was closed by hand rather than by a deadline). Ties —
 * including two open-ended rounds — break on `id` descending: ids are
 * uuidv7, so descending id is descending creation time. Matches the server's
 * own ordering in `apps/server/src/game/rounds/routes.ts` so the client's
 * copy of the same logic can be tested without a server.
 */
export function hallOfFameOrder(rounds: readonly RoundDto[]): RoundDto[] {
  return [...rounds].sort((a, b) => {
    if (a.endsAt === null && b.endsAt === null) return b.id.localeCompare(a.id);
    if (a.endsAt === null) return 1;
    if (b.endsAt === null) return -1;
    if (a.endsAt !== b.endsAt) return a.endsAt < b.endsAt ? 1 : -1;
    return b.id.localeCompare(a.id);
  });
}

function ScoreCell(
  { kind, mode, value, format }:
  { kind: LeaderboardKind; mode: "exp" | "level" | undefined; value: string; format: ReturnType<typeof useMoneyFormat> },
): JSX.Element {
  if (mode === "level") return <>{formatBoardScore(kind, mode, value, format)}</>;
  return kind === "exp" ? <Amount value={value} /> : <Money value={value} />;
}

function StandingsTable({ roundId, kind }: { roundId: string; kind: LeaderboardKind }): JSX.Element {
  const standings = useRoundStandings(roundId, kind);
  const me = useMe();
  const moneyFormat = useMoneyFormat();
  const mode = standings.data?.mode;

  if (standings.isLoading) return <Loading what="the board" />;
  return (
    <>
      <ErrorText error={standings.error} />
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>{mode === "level" ? "Level" : kind === "exp" ? "Exp" : "Amount"}</th>
          </tr>
        </thead>
        <tbody>
          {standings.data?.entries.map((entry) => (
            <tr
              key={entry.playerId}
              className={entry.playerId === me.data?.playerId ? styles.self : undefined}
            >
              <td>{entry.rank}</td>
              <td><PlayerLink playerId={entry.playerId} username={entry.username} /></td>
              <td><ScoreCell kind={kind} mode={mode} value={entry.score} format={moneyFormat} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ActiveRound({ round }: { round: RoundDto }): JSX.Element {
  const [kind, setKind] = useState<LeaderboardKind>("exp");
  // Ticks the server's snapshot down locally between refetches; resets to the
  // fresh value whenever a refetch lands (round.id changes across rounds too).
  const [secondsRemaining, setSecondsRemaining] = useState(round.secondsRemaining);
  useEffect(() => {
    setSecondsRemaining(round.secondsRemaining);
    if (round.secondsRemaining === null) return;
    const timer = setInterval(() => {
      setSecondsRemaining((current) => (current === null ? null : Math.max(0, current - 1)));
    }, 1_000);
    return () => { clearInterval(timer); };
  }, [round.id, round.secondsRemaining]);

  return (
    <div className={styles.stack}>
      <h3 className={styles.meta}>{round.name}</h3>
      <p className={styles.meta}>
        {round.startsAt !== null ? <When iso={round.startsAt} /> : "no start date"}
        {" → "}
        {round.endsAt !== null ? <When iso={round.endsAt} /> : "no end date"}
        {" · "}
        {formatCountdown(secondsRemaining)}
      </p>

      <div className={styles.tabs}>
        {KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === kind}
            className={value === kind ? styles.tabActive : styles.tabIdle}
            onClick={() => { setKind(value); }}
          >
            {label}
          </button>
        ))}
      </div>

      <StandingsTable roundId={round.id} kind={kind} />
    </div>
  );
}

function HallOfFameEntry({ round }: { round: RoundDto }): JSX.Element {
  const [kind, setKind] = useState<LeaderboardKind>("exp");

  return (
    <details className={styles.row}>
      <summary>
        {round.name}
        {round.endsAt !== null ? <> &middot; <When iso={round.endsAt} /></> : null}
      </summary>
      <div className={styles.tabs}>
        {KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === kind}
            className={value === kind ? styles.tabActive : styles.tabIdle}
            onClick={() => { setKind(value); }}
          >
            {label}
          </button>
        ))}
      </div>
      <StandingsTable roundId={round.id} kind={kind} />
    </details>
  );
}

export function Rounds(): JSX.Element {
  const rounds = useRounds();

  if (rounds.isLoading) return <Loading what="rounds" />;
  if (rounds.error) return <ErrorText error={rounds.error} />;

  const active = rounds.data?.active ?? null;
  const finished = hallOfFameOrder(rounds.data?.finished ?? []);

  return (
    <Panel title="Rounds">
      {active === null ? (
        <p className={styles.meta}>No season is running.</p>
      ) : (
        <ActiveRound round={active} />
      )}

      <h3 className={styles.meta}>Hall of fame</h3>
      {finished.length === 0 ? (
        <p className={styles.meta}>No rounds have finished yet.</p>
      ) : (
        <div className={styles.rows}>
          {finished.map((round) => <HallOfFameEntry key={round.id} round={round} />)}
        </div>
      )}
    </Panel>
  );
}
