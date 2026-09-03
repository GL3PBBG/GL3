import { Link } from "react-router-dom";
import { useCheckin, useDischarge, useDischargePlayer, useHospital, useMe, useWard } from "../api/queries.js";
import { useSentenceCountdown, formatDuration, canAfford } from "@gl3/client";
import { PlayerLink } from "../components/PlayerLink.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Hospital(): JSX.Element {
  const hospital = useHospital();
  const me = useMe();
  const discharge = useDischarge();
  const checkin = useCheckin();
  const ward = useWard();
  const dischargePlayer = useDischargePlayer();

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

  return (
    <>
      <Panel title="Hospital">
        {status.hospitalised ? (
          <>
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
          </>
        ) : (
          <>
            <p className={styles.ok} style={{ margin: 0 }}>
              You're not in hospital. Health {status.health} / {status.maxHealth}.
            </p>
            {status.health < status.maxHealth ? (
              <>
                <p className={styles.meta}>
                  Checking in heals you to {status.maxHealth} but takes you out of crimes,
                  combat and travel until the stay ends.
                </p>
                <button type="button" disabled={checkin.isPending} onClick={() => checkin.mutate()}>
                  {checkin.isPending ? "Checking in…" : "Check yourself in"}
                </button>
                <ErrorText error={checkin.error} />
              </>
            ) : null}
            <p className={styles.meta}>
              <Link to="/plugins/combat.index">Back to combat</Link>
            </p>
          </>
        )}
      </Panel>

      <Panel title="In this ward">
        {ward.data === undefined ? <Loading what="the ward" /> : null}
        {ward.data?.patients.length === 0 ? (
          <p className={styles.muted}>Nobody else is in this town's hospital.</p>
        ) : null}
        {ward.data?.patients.map((patient) => (
          <div key={patient.playerId} className={styles.row}>
            <span><PlayerLink playerId={patient.playerId} username={patient.username} /> ({patient.rankName})</span>
            <span>{formatDuration(patient.remainingSeconds)}</span>
            <button
              type="button"
              // Prevents double-spend.
              disabled={dischargePlayer.isPending || !canAfford(cash, patient.dischargeCost)}
              onClick={() => dischargePlayer.mutate(patient.playerId)}
            >
              Pay <Money value={patient.dischargeCost} />
            </button>
          </div>
        ))}
        <ErrorText error={dischargePlayer.error} />
      </Panel>
    </>
  );
}
