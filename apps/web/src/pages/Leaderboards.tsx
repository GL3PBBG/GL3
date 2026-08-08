import { useState } from "react";
import type { LeaderboardKind } from "@gl3/shared";
import { useLeaderboard, useMe } from "../api/queries.js";
import { Amount, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

const KINDS: ReadonlyArray<readonly [LeaderboardKind, string]> = [
  ["cash", "Cash"],
  ["bank", "Bank"],
  ["exp", "Exp"],
];

export function Leaderboards(): JSX.Element {
  const [kind, setKind] = useState<LeaderboardKind>("cash");
  const board = useLeaderboard(kind);
  const me = useMe();

  return (
    <Panel title="Leaderboards">
      <div className={styles.tabs}>
        {KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={value === kind ? styles.tabActive : styles.tabIdle}
            onClick={() => { setKind(value); }}
          >
            {label}
          </button>
        ))}
      </div>

      {board.isLoading ? <Loading what="the board" /> : null}
      <ErrorText error={board.error} />

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
              <td>{entry.username}</td>
              <td>{kind === "exp" ? <Amount value={entry.score} /> : <Money value={entry.score} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
