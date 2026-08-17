import { Link } from "react-router-dom";
import { useJail } from "../api/queries.js";
import { useSentenceCountdown } from "../hooks/useSentenceCountdown.js";
import { formatDuration } from "../lib/errors.js";
import { Loading, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Jail(): JSX.Element {
  const jail = useJail();
  // The socket re-anchors this on `player.released`; the slow safety poll
  // re-anchors it if the socket is down. The display ticks locally every 1s
  // between anchors, which is what stops a throttled or suspended tab showing
  // a sentence that expired minutes ago (see lib/countdown.ts).
  const jailSeconds = useSentenceCountdown(
    "jail", jail.data?.jailed === true ? jail.data.remainingSeconds : undefined,
    jail.dataUpdatedAt,
  );

  if (jail.isLoading) return <Loading what="jail status" />;

  // The server's sentence sweeper is what frees a player now — GET /api/jail
  // still calls releaseIfExpired as a backstop, so this page works even with
  // the sweeper disabled (SWEEP_INTERVAL_MS=0).
  if (jail.data?.jailed !== true) {
    return (
      <Panel title="Jail">
        <p className={styles.ok} style={{ margin: 0 }}>You're free.</p>
        <p className={styles.meta}>
          <Link to="/crimes">Back to work</Link>
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Jail">
      <p className={styles.big}>{formatDuration(jailSeconds)}</p>
      <p className={styles.meta}>
        Out at{" "}
        {jail.data.until === null ? "any moment" : new Date(jail.data.until).toLocaleTimeString()}.
        You'll be let out automatically.
      </p>
    </Panel>
  );
}
