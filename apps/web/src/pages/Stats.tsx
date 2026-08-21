import type { ReactNode } from "react";
import type { GameStatsResponse } from "@gl3/shared";
import { useStats } from "../api/queries.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import {
  barPath, countFractions, indexOfMax, layoutBars, moneyFractions,
} from "../lib/chart.js";
import styles from "./Stats.module.css";

/**
 * The SVG coordinate space. Width is arbitrary — the element is sized in CSS
 * and the viewBox stretches to fit — but the ratio decides how chunky the
 * bars look before `maxBarWidth` caps them.
 */
const PLOT = { width: 280, height: 44 };

/**
 * `2026-08-21` → `Aug 21`, pinned to UTC. The server buckets by UTC day, so
 * formatting in the viewer's zone would slide every label off its own bar.
 */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

interface TrendChartProps {
  title: string;
  /** 0..1 per day, already scaled against the series maximum. */
  fractions: number[];
  days: string[];
  /** One tooltip line per day, e.g. `Aug 21 · 4 crimes`. */
  tooltips: string[];
  /** Rendered under the title: the peak, or an empty-range note. */
  note: ReactNode;
  label: string;
}

/**
 * One series, fourteen daily columns. Single series, so no legend — the title
 * names what is plotted — and no value on every bar: the peak is called out
 * once above the plot and the rest live in the table below the page.
 */
function TrendChart({ title, fractions, days, tooltips, note, label }: TrendChartProps): JSX.Element {
  const bars = layoutBars(fractions, PLOT);
  const slot = PLOT.width / Math.max(1, days.length);

  return (
    <div className={styles.chartCard}>
      <h3 className={styles.chartTitle}>{title}</h3>
      <p className={styles.chartNote}>{note}</p>
      {/* Uniform scaling (no preserveAspectRatio="none"): a stretched viewBox
          would squash the bars' 4px corner radius into ellipses on a wide
          card. `non-scaling-stroke` keeps the baseline a true hairline at any
          size, which is the one thing scaling would otherwise thicken. */}
      <svg
        className={styles.plot}
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="img"
        aria-label={label}
      >
        {bars.map((bar, i) => (
          <g key={days[i]}>
            <title>{tooltips[i]}</title>
            <rect className={styles.hit} x={i * slot} y={0} width={slot} height={PLOT.height} />
            <path className={styles.bar} d={barPath(bar)} />
          </g>
        ))}
        <line
          className={styles.baseline} vectorEffect="non-scaling-stroke"
          x1="0" y1={PLOT.height} x2={PLOT.width} y2={PLOT.height}
        />
      </svg>
      <div className={styles.axis}>
        <span>{shortDay(days[0] ?? "")}</span>
        <span>{shortDay(days[days.length - 1] ?? "")}</span>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value.toLocaleString()}</span>
    </div>
  );
}

function Numbers({ stats }: { stats: GameStatsResponse }): JSX.Element {
  const { days, newPlayers, crimes, moneyMoved } = stats.trends;
  return (
    <details className={styles.details}>
      <summary>Show the numbers</summary>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Day (UTC)</th>
            <th className={styles.numeric}>New players</th>
            <th className={styles.numeric}>Crimes</th>
            <th className={styles.numeric}>Money moved</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day, i) => (
            <tr key={day}>
              <td>{day}</td>
              <td className={styles.numeric}>{(newPlayers[i] ?? 0).toLocaleString()}</td>
              <td className={styles.numeric}>{(crimes[i] ?? 0).toLocaleString()}</td>
              <td className={styles.numeric}><Money value={moneyMoved[i] ?? "0"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function Stats(): JSX.Element {
  const stats = useStats();

  if (stats.isLoading) return <Loading what="the stats" />;
  // No data and not loading means the fetch or the schema parse failed; the
  // error is the whole page in that case.
  if (stats.data === undefined) return <><ErrorText error={stats.error ?? new Error("no stats")} /></>;

  const { totals, trends } = stats.data;
  const newPlayerFractions = countFractions(trends.newPlayers);
  const crimeFractions = countFractions(trends.crimes);
  const moneyFractionsByDay = moneyFractions(trends.moneyMoved);

  const peakNewPlayers = indexOfMax(newPlayerFractions);
  const peakCrimes = indexOfMax(crimeFractions);
  const peakMoney = indexOfMax(moneyFractionsByDay);

  const total = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);

  return (
    <>
      <ErrorText error={stats.error} />

      <Panel title="The city">
        {/* The one hero figure on the page — every other number is a tile. */}
        <div className={styles.hero}>
          <span className={styles.heroLabel}>Money in circulation</span>
          <span className={styles.heroValue}><Money value={totals.moneySupply} /></span>
          <span className={styles.heroNote}>Cash and bank, across every player.</span>
        </div>

        <div className={styles.tiles}>
          <Tile label="Players" value={totals.playersTotal} />
          <Tile label="Online now" value={totals.onlineNow} />
          <Tile label="In jail" value={totals.jailedNow} />
          <Tile label="In hospital" value={totals.hospitalisedNow} />
          <Tile label="Gangs" value={totals.gangsTotal} />
        </div>
      </Panel>

      <Panel title="The last 14 days">
        <div className={styles.charts}>
          <TrendChart
            title="New players"
            fractions={newPlayerFractions}
            days={trends.days}
            tooltips={trends.days.map((day, i) => `${shortDay(day)} · ${trends.newPlayers[i] ?? 0} joined`)}
            label={`New players per day over the last 14 days, ${total(trends.newPlayers)} in total`}
            note={peakNewPlayers === -1
              ? "Nobody joined in this range."
              : `${total(trends.newPlayers).toLocaleString()} joined · peak ${trends.newPlayers[peakNewPlayers]} on ${shortDay(trends.days[peakNewPlayers]!)}`}
          />
          <TrendChart
            title="Crimes committed"
            fractions={crimeFractions}
            days={trends.days}
            tooltips={trends.days.map((day, i) => `${shortDay(day)} · ${trends.crimes[i] ?? 0} crimes`)}
            label={`Crimes per day over the last 14 days, ${total(trends.crimes)} in total`}
            note={peakCrimes === -1
              ? "No crimes in this range."
              : `${total(trends.crimes).toLocaleString()} crimes · peak ${trends.crimes[peakCrimes]} on ${shortDay(trends.days[peakCrimes]!)}`}
          />
          <TrendChart
            title="Money moved"
            fractions={moneyFractionsByDay}
            days={trends.days}
            tooltips={trends.days.map((day, i) => `${shortDay(day)} · ${trends.moneyMoved[i] ?? "0"}`)}
            label="Total value moved through the ledger per day over the last 14 days"
            note={peakMoney === -1
              ? "The ledger was quiet in this range."
              : <>Busiest day <Money value={trends.moneyMoved[peakMoney]!} /> on {shortDay(trends.days[peakMoney]!)}</>}
          />
        </div>

        <Numbers stats={stats.data} />
      </Panel>

      <p className={styles.heroNote}>
        Measured <When iso={stats.data.generatedAt} />. Refreshes every five minutes.
      </p>
    </>
  );
}
