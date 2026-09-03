import { useMe, usePlugins, useRanks } from "../api/queries.js";
import { formatAmount, rankProgress } from "@gl3/client";
import { Amount, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";
import { GameImage } from "../components/GameImage.js";

export function Ranks(): JSX.Element {
  const me = useMe();
  const ranks = useRanks();
  const plugins = usePlugins();

  // `plugins` too: without it the page would flash the exp derivation on a
  // level boot until the manifest arrives (the HUD tolerates that; a page
  // whose whole content is the gate should not).
  if (ranks.isLoading || plugins.isLoading || !me.data) return <Loading what="ranks" />;

  const rows = ranks.data?.ranks ?? [];
  const moneyRanks = ranks.data?.moneyRanks ?? [];
  // Same switch as the HUD (`rankProgress`): on a routed boot the ladder is
  // climbed by level, one rung per level, and `exp` is within-level exp that
  // means nothing against the thresholds — so the exp bar goes away there
  // rather than showing progress towards a number that isn't the gate.
  const level = plugins.data?.progression === "level";
  const progress = rankProgress(plugins.data?.progression, me.data, rows);

  return (
    <Panel title="Ranks">
      {level ? (
        <p className={styles.meta}>
          Level {me.data.level}
          {progress.next === null
            ? " — nothing left to climb."
            : ` — ${progress.next.name} at level ${me.data.level + 1}.`}
        </p>
      ) : (
        <>
          <p className={styles.meta}>
            <Amount value={me.data.exp} /> exp
            {progress.next === null
              ? " — nothing left to climb."
              : ` — ${formatAmount(
                  (BigInt(progress.next.expRequired) - BigInt(me.data.exp)).toString(),
                )} to ${progress.next.name}.`}
          </p>
          <div className={styles.bar}>
            <div className={styles.barFill} style={{ width: `${progress.pct}%` }} />
          </div>
        </>
      )}

      <ul className={styles.rows}>
        {rows.map((rank) => (
          <li
            key={rank.id}
            className={rank.current ? `${styles.row} ${styles.rowCurrent}` : styles.row}
          >
            <GameImage url={rank.imageUrl} alt={rank.name} size="sm" />
            <div className={styles.rowGrow}>
              <strong>{rank.name}</strong>
              {rank.current ? <span className={styles.meta}> · you</span> : null}
              <div className={styles.meta}>
                {level && rank.levelRequired !== undefined
                  ? <>Level {rank.levelRequired}</>
                  : <><Amount value={rank.expRequired} /> exp</>}
                {" "}· reward <Money value={rank.cashReward} /> +{" "}
                {rank.bulletReward} bullets · {rank.maxHealth} hp
              </div>
            </div>
          </li>
        ))}
      </ul>

      <h3 className={styles.meta}>Wealth</h3>
      <ul className={styles.rows}>
        {moneyRanks.map((moneyRank) => (
          <li key={moneyRank.id} className={styles.row}>
            <strong>{moneyRank.label}</strong>
            <span className={styles.meta}><Money value={moneyRank.threshold} /></span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
