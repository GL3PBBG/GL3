import type { OnlineEntry } from "@gl3/shared";
import { useOnline } from "../api/queries.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { ErrorText, Loading, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

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

export function Online(): JSX.Element {
  const online = useOnline();

  return (
    <Panel title="Online">
      {online.isLoading ? <Loading what="who's online" /> : null}
      <ErrorText error={online.error} />

      <div className={styles.stack}>
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
