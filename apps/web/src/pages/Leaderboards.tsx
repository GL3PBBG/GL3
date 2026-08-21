import { useState } from "react";
import type { LeaderboardKind } from "@gl3/shared";
import { useLeaderboard, useMe } from "../api/queries.js";
import { Amount, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import { PlayerLink } from "../components/PlayerLink.js";
import styles from "./pages.module.css";

const KINDS: ReadonlyArray<readonly [LeaderboardKind, string]> = [
  ["cash", "Cash"],
  ["bank", "Bank"],
  ["exp", "Exp"],
];

const SCOPES: ReadonlyArray<readonly ["round" | "all", string]> = [
  ["all", "All-time"],
  ["round", "This season"],
];

export function Leaderboards(): JSX.Element {
  const [kind, setKind] = useState<LeaderboardKind>("cash");
  const [scope, setScope] = useState<"round" | "all">("all");
  const board = useLeaderboard(kind, scope);
  const me = useMe();

  // A round board that has not loaded and one that loaded empty both render
  // as "no rows yet" — distinguish them, or an empty season reads as a bug.
  const noSeason = scope === "round" && !board.isLoading && board.data?.entries.length === 0;

  return (
    <Panel title="Leaderboards">
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
      <div className={styles.tabs}>
        {SCOPES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === scope}
            className={value === scope ? styles.tabActive : styles.tabIdle}
            onClick={() => { setScope(value); }}
          >
            {label}
          </button>
        ))}
      </div>

      {board.isLoading ? <Loading what="the board" /> : null}
      <ErrorText error={board.error} />

      {noSeason ? (
        <p className={styles.meta}>No season is running.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>{kind === "exp" ? "Exp" : "Amount"}</th>
            </tr>
          </thead>
          <tbody>
            {board.data?.entries.map((entry) => (
              <tr
                key={entry.playerId}
                className={entry.playerId === me.data?.playerId ? styles.self : undefined}
              >
                <td>{entry.rank}</td>
                <td><PlayerLink playerId={entry.playerId} username={entry.username} /></td>
                <td>{kind === "exp" ? <Amount value={entry.score} /> : <Money value={entry.score} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
