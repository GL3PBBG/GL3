import { useMe, useRanks } from "../api/queries.js";
import { formatAmount } from "../lib/money.js";
import { progressToNextRank } from "../lib/ranks.js";
import { Amount, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Ranks(): JSX.Element {
  const me = useMe();
  const ranks = useRanks();

  if (ranks.isLoading || !me.data) return <Loading what="ranks" />;

  const rows = ranks.data?.ranks ?? [];
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

      <ul className={styles.rows}>
        {rows.map((rank) => (
          <li
            key={rank.id}
            className={rank.current ? `${styles.row} ${styles.rowCurrent}` : styles.row}
          >
            <div>
              <strong>{rank.name}</strong>
              {rank.current ? <span className={styles.meta}> · you</span> : null}
              <div className={styles.meta}>
                <Amount value={rank.expRequired} /> exp · reward <Money value={rank.cashReward} /> +{" "}
                {rank.bulletReward} bullets · {rank.maxHealth} hp
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
