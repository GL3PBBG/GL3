import { Link } from "react-router-dom";
import { useDischarge, useHospital, useMe } from "../api/queries.js";
import { useSentenceCountdown } from "../hooks/useSentenceCountdown.js";
import { formatDuration } from "../lib/errors.js";
import { canAfford } from "../lib/money.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Hospital(): JSX.Element {
  const hospital = useHospital();
  const me = useMe();
  const discharge = useDischarge();

  // The socket re-anchors this on `player.discharged`; the slow safety poll
  // re-anchors it if the socket is down. The display ticks locally every 1s
  // between anchors, which is what stops a throttled or suspended tab showing
  // a sentence that expired minutes ago (see lib/countdown.ts).
  const hospitalSeconds = useSentenceCountdown(
    "hospital", hospital.data?.hospitalised === true ? hospital.data.remainingSeconds : undefined,
    hospital.dataUpdatedAt,
  );

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
      <p className={styles.big}>{formatDuration(hospitalSeconds)}</p>
      <p className={styles.meta}>
        Discharge now for <Money value={status.dischargeCost} /> — heals you fully.
        You'll be discharged automatically.
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
