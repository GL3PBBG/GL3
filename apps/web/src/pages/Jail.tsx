import { Link } from "react-router-dom";
import { useBail, useBust, useCellBlock, useEscape, useJail, useMe } from "../api/queries.js";
import { useSentenceCountdown } from "../hooks/useSentenceCountdown.js";
import { formatDuration } from "../lib/errors.js";
import { canAfford } from "../lib/money.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { SlotImage } from "../components/GameImage.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Jail(): JSX.Element {
  const jail = useJail();
  const me = useMe();
  const cellBlock = useCellBlock();
  const bail = useBail();
  const bust = useBust();
  const escape = useEscape();

  // The socket re-anchors this on `player.released`; the slow safety poll
  // re-anchors it if the socket is down. The display ticks locally every 1s
  // between anchors, which is what stops a throttled or suspended tab showing
  // a sentence that expired minutes ago (see lib/countdown.ts).
  const jailSeconds = useSentenceCountdown(
    "jail", jail.data?.jailed === true ? jail.data.remainingSeconds : undefined,
    jail.dataUpdatedAt,
  );

  if (jail.isLoading) return <Loading what="jail status" />;

  if (!jail.data) return <Loading what="jail status" />;

  const status = jail.data;
  const cash = me.data?.cash ?? "0";

  const inSuperMax = status.jailed && status.superMax;

  return (
    <>
      {/* The one state-dependent banner: which slot renders depends on whether
          the caller is currently super-maxed, so this can't live in Shell's
          static route→slot map — see the PAGE_BANNERS comment there. */}
      <SlotImage
        scope="core"
        slot={inSuperMax ? "page-supermax" : "page-jail"}
        alt={inSuperMax ? "Super max" : "Jail"}
        size="banner" zoomable={false}
      />

      <Panel title="Jail">
        {status.jailed ? (
          <>
            <p className={styles.big}>{formatDuration(jailSeconds)}</p>
            <p className={styles.meta}>
              Out at{" "}
              {status.until === null ? "any moment" : new Date(status.until).toLocaleTimeString()}.
              You'll be let out automatically.
            </p>
            {status.superMax ? (
              <>
                <p className={styles.big}>SUPER MAX</p>
                <p className={styles.muted}>
                  Your escape attempt failed. No more attempts, no bail, no rescue — you sit out the clock.
                </p>
              </>
            ) : (
              <>
                {/* Prevents a double roll. */}
                <button type="button" disabled={escape.isPending} onClick={() => escape.mutate()}>
                  Escape
                </button>
                <p className={styles.muted}>
                  Escaping is free — fail and it's +90 seconds and super max: no more attempts, no bail, no rescue.
                </p>
              </>
            )}
            <ErrorText error={escape.error} />
          </>
        ) : (
          <>
            <p className={styles.ok} style={{ margin: 0 }}>You're free.</p>
            <p className={styles.meta}>
              <Link to="/plugins/crimes.index">Back to work</Link>
            </p>
          </>
        )}
      </Panel>

      <Panel title="In this cell block">
        {cellBlock.data === undefined ? <Loading what="the cell block" /> : null}
        {cellBlock.data?.inmates.length === 0 ? (
          <p className={styles.muted}>Nobody else is doing time in this town.</p>
        ) : null}
        {cellBlock.data?.inmates.map((inmate) => (
          <div key={inmate.playerId} className={styles.row}>
            <span>
              <PlayerLink playerId={inmate.playerId} username={inmate.username} /> ({inmate.rankName})
              {inmate.superMax ? <> · <span className={styles.bad}>SUPER MAX</span></> : null}
            </span>
            <span>{formatDuration(inmate.remainingSeconds)} · {inmate.percent}%</span>
            <button
              type="button"
              // Prevents double-spend.
              disabled={inmate.superMax || bail.isPending || !canAfford(cash, inmate.bailCost)}
              onClick={() => bail.mutate(inmate.playerId)}
            >
              Bail <Money value={inmate.bailCost} />
            </button>
            {/* Prevents double-spend. */}
            <button
              type="button"
              disabled={inmate.superMax || bust.isPending}
              onClick={() => bust.mutate(inmate.playerId)}
            >
              Bust out
            </button>
          </div>
        ))}
        <p className={styles.muted}>Busting is free, but a failed attempt puts you in the next cell for 90 seconds.</p>
        <ErrorText error={bail.error} />
        <ErrorText error={bust.error} />
      </Panel>
    </>
  );
}
