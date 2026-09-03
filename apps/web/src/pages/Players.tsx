import { useState } from "react";
import type { OnlineEntry, PlayerSearchEntry } from "@gl3/shared";
import { PlayerLink } from "../components/PlayerLink.js";
import { ErrorText, Loading, Panel, When } from "../components/ui.js";
import { useDebouncedValue, useOnline, usePlayerSearch } from "@gl3/client";
import styles from "./pages.module.css";

/** The server refuses anything shorter, so the query is held back to match. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

function Roster({ rows }: { rows: readonly OnlineEntry[] }): JSX.Element {
  if (rows.length === 0) return <p className={styles.muted}>Nobody.</p>;
  return (
    <ul className={styles.rows}>
      {rows.map((entry) => (
        <li key={entry.playerId} className={styles.row}>
          <span>
            <PlayerLink playerId={entry.playerId} username={entry.username} />
            {/* A concealed location renders "—", never the word "hidden" —
                concealment shouldn't advertise itself. */}
            <span className={styles.muted}> · {entry.locationName ?? "—"}</span>
          </span>
          <span className={styles.meta}><When iso={entry.lastActiveAt} /></span>
        </li>
      ))}
    </ul>
  );
}

function Results({ rows }: { rows: readonly PlayerSearchEntry[] }): JSX.Element {
  if (rows.length === 0) return <p className={styles.muted}>No matches.</p>;
  return (
    <ul className={styles.rows}>
      {rows.map((entry) => (
        <li key={entry.playerId} className={styles.row}>
          <PlayerLink playerId={entry.playerId} username={entry.username} />
          {/* Rank only. Search carries no location, so an underground town's
              residents are as findable by name as anyone else without the
              search becoming the seam that places them. */}
          <span className={styles.meta}>{entry.rankName ?? "Unranked"}</span>
        </li>
      ))}
    </ul>
  );
}

export function Players(): JSX.Element {
  const online = useOnline();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, DEBOUNCE_MS).trim();
  const searchable = debounced.length >= MIN_QUERY_LENGTH;
  const search = usePlayerSearch(debounced, searchable);

  return (
    <Panel title="Players">
      <div className={styles.stack}>
        <div>
          <label className={styles.field} htmlFor="player-search">
            Find a player
            <input
              id="player-search"
              type="search"
              value={query}
              placeholder="At least two characters"
              onChange={(event) => { setQuery(event.target.value); }}
            />
          </label>
          <ErrorText error={search.error} />
          {/* Results are shown only while the debounced term is long enough:
              dropping under two characters must clear them, and react-query
              keeps the last term's data cached under its own key. */}
          {searchable && search.isPending ? <Loading what="players" /> : null}
          {searchable && search.data ? <Results rows={search.data.players} /> : null}
        </div>

        {online.isLoading ? <Loading what="who's online" /> : null}
        <ErrorText error={online.error} />

        <div>
          <h3 className={styles.meta}>Online now</h3>
          <Roster rows={online.data?.onlineNow ?? []} />
        </div>
        <div>
          <h3 className={styles.meta}>Active in the last hour</h3>
          <Roster rows={online.data?.lastHour ?? []} />
        </div>
      </div>
    </Panel>
  );
}
