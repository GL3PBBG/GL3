import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useDischarge, useHospital, useMe } from "../api/queries.js";
import { useCountdowns } from "../hooks/useCountdowns.js";
import { formatDuration } from "../lib/errors.js";
import { canAfford } from "../lib/money.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Hospital(): JSX.Element {
  const hospital = useHospital();
  const me = useMe();
  const discharge = useDischarge();
  const { remaining, seed } = useCountdowns();

  // The poll is every 2s; the display ticks every 1s. Each poll re-anchors the
  // local clock, which is what stops a throttled or suspended tab showing a
  // sentence that expired minutes ago.
  useEffect(() => {
    seed("hospital", hospital.data?.remainingSeconds ?? 0);
  }, [hospital.data, seed]);

  if (hospital.isLoading) return <Loading what="hospital status" />;

  if (!hospital.data) return <Loading what="hospital status" />;

  const status = hospital.data;
  const cash = me.data?.cash ?? "0";
  const affordable = canAfford(cash, status.dischargeCost);

  if (!status.hospitalised) {
    return (
      <Panel title="Hospital">
        <p className={styles.ok} style={{ margin: 0 }}>
          You're not in hospital. Health {status.health} / {status.maxHealth}.
        </p>
        <p className={styles.meta}>
          <Link to="/combat">Back to combat</Link>
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Hospital">
      <p className={styles.meta}>
        Health {status.health} / {status.maxHealth}
      </p>
      <p className={styles.big}>{formatDuration(remaining["hospital"] ?? status.remainingSeconds)}</p>
      <p className={styles.meta}>
        Discharge now for <Money value={status.dischargeCost} /> — heals you fully.
        This page checks every couple of seconds and lets you out automatically.
      </p>
      <ErrorText error={discharge.error} />
      <button
        type="button"
        disabled={discharge.isPending || !affordable}
        onClick={() => discharge.mutate()}
      >
        {discharge.isPending ? "Paying…" : "Pay and leave"}
      </button>
      {!affordable ? (
        <p className={styles.muted}>You can't afford it. Wait it out.</p>
      ) : null}
    </Panel>
  );
}
