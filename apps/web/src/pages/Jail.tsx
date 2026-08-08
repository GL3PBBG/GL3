import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useJail } from "../api/queries.js";
import { useCountdowns } from "../hooks/useCountdowns.js";
import { formatDuration } from "../lib/errors.js";
import { Loading, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Jail(): JSX.Element {
  const jail = useJail();
  const { remaining, seed } = useCountdowns();

  // The poll is every 2s; the display should tick every 1s. seed() no-ops while
  // a timer is already running, so the poll only re-seeds after the local clock
  // has drained — which is also when a still-jailed player needs a fresh number.
  useEffect(() => {
    seed("jail", jail.data?.remainingSeconds ?? 0);
  }, [jail.data, seed]);

  if (jail.isLoading) return <Loading what="jail status" />;

  // GET /api/jail is what actually runs releaseIfExpired server-side — there is
  // no cron, so this page sitting open polling is the release.
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
      <p className={styles.big}>{formatDuration(remaining["jail"] ?? jail.data.remainingSeconds)}</p>
      <p className={styles.meta}>
        Out at{" "}
        {jail.data.until === null ? "any moment" : new Date(jail.data.until).toLocaleTimeString()}.
        This page checks every couple of seconds and lets you out automatically.
      </p>
    </Panel>
  );
}
