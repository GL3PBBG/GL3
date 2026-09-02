import { useMe, useRanks } from "../api/queries.js";
import { formatAmount } from "../lib/money.js";
import { progressToNextRank } from "../lib/ranks.js";
import { Amount, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";
import { GameImage } from "../components/GameImage.js";

export function Ranks(): JSX.Element {
  const me = useMe();
  const ranks = useRanks();

  if (ranks.isLoading || !me.data) return <Loading what="ranks" />;

  const rows = ranks.data?.ranks ?? [];
  const moneyRanks = ranks.data?.moneyRanks ?? [];
  const progress = progressToNextRank(me.data.exp, rows);

  return (
    <Panel title="Ranks">
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

      <p className={styles.meta}>
        Which gate applies depends on this install&rsquo;s progression model.
      </p>
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
                {rank.levelRequired !== undefined ? <>Level {rank.levelRequired} · </> : null}
                <Amount value={rank.expRequired} /> exp · reward <Money value={rank.cashReward} /> +{" "}
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
