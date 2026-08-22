import type { ReactNode } from "react";
import type { AdminEconomyDay } from "@gl3/shared";
import { useAdminEconomyOverview } from "../api/queries.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import {
  barPath, barPathDown, layoutSignedBars, moneyFractions, signedFractions,
  sparklinePath, sparklinePoints, supplySeries,
} from "../lib/chart.js";
import { formatMoney } from "../lib/money.js";
import { useMoneyFormat } from "../lib/formatContext.js";
import styles from "./AdminEconomy.module.css";

/**
 * The bespoke MIMO dashboard — the one core admin page that outgrew the static
 * view vocabulary (totals tiles and charts are not vocabulary kinds), reached
 * through PAGE_OVERRIDES under the economy page's id. All data comes from one
 * round trip (`GET /api/admin/economy/overview`, cached five minutes
 * server-side); the grant gate stays server-side where it has always been.
 *
 * Reading order mirrors how an operator thinks: how much money exists and
 * which way the taps are running (tiles), the shape of the month (charts),
 * then the per-reason detail (table).
 */

const PLOT = { width: 280, height: 64 };

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

/**
 * Signed money as one coloured figure: `+$1,200` in accent, `-$800` in
 * danger. The DTO's net is a plain MoneySchema string — formatMoney supplies
 * the symbol and grouping, the explicit `+` is added here because a faucet
 * and a zero must not read identically.
 */
function SignedMoney({ value }: { value: string }): JSX.Element {
  const format = useMoneyFormat();
  const positive = !value.startsWith("-");
  return (
    <span className={positive ? styles.faucet : styles.sink}>
      {positive ? "+" : ""}{formatMoney(value, format)}
    </span>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{children}</span>
    </div>
  );
}

function DailyNetChart({ daily }: { daily: AdminEconomyDay[] }): JSX.Element {
  const days = daily.map((d) => d.day);
  const fractions = signedFractions(daily.map((d) => d.net));
  const { bars, zeroY } = layoutSignedBars(fractions, PLOT);
  const slot = PLOT.width / Math.max(1, days.length);
  const format = useMoneyFormat();

  const faucetDays = daily.filter((d) => !d.net.startsWith("-") && d.net !== "0").length;
  const sinkDays = daily.length - faucetDays - daily.filter((d) => d.net === "0").length;

  return (
    <div className={styles.chartCard}>
      <h3 className={styles.chartTitle}>Daily net flow</h3>
      <p className={styles.chartNote}>
        Faucet days rise in gold, sink days hang in red. The zero line moves to
        where the data puts it.
      </p>
      <svg
        className={styles.plot}
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="img"
        aria-label={`Net money created or destroyed per day over the last ${daily.length} days`}
      >
        {bars.map((bar, i) => {
          const day = daily[i]!;
          const up = fractions[i]! >= 0;
          return (
            <g key={day.day}>
              <title>{`${shortDay(day.day)} · in ${formatMoney(day.inflow, format)} / out ${formatMoney(day.outflow, format)} → net ${formatMoney(day.net, format)}`}</title>
              <rect className={styles.hit} x={i * slot} y={0} width={slot} height={PLOT.height} />
              <path className={up ? styles.barUp : styles.barDown} d={up ? barPath(bar) : barPathDown(bar)} />
            </g>
          );
        })}
        <line
          className={styles.zero} vectorEffect="non-scaling-stroke"
          x1="0" y1={zeroY} x2={PLOT.width} y2={zeroY}
        />
      </svg>
      <div className={styles.axis}>
        <span>{shortDay(days[0] ?? "")}</span>
        <span>{faucetDays} faucet · {sinkDays} sink days</span>
        <span>{shortDay(days[days.length - 1] ?? "")}</span>
      </div>
    </div>
  );
}

function SupplyChart({ supplyNow, daily }: { supplyNow: string; daily: AdminEconomyDay[] }): JSX.Element {
  const format = useMoneyFormat();
  // sum(ledger) == balance makes each day's net the supply delta, so walking
  // today's supply backwards reconstructs history without a snapshot table
  // (lib/chart.ts's supplySeries).
  const series = supplySeries(supplyNow, daily.map((d) => d.net));
  const points = sparklinePoints(moneyFractions(series), PLOT);
  const first = series[0] ?? supplyNow;
  const change = BigInt(supplyNow) - BigInt(first);

  return (
    <div className={styles.chartCard}>
      <h3 className={styles.chartTitle}>Money supply</h3>
      <p className={styles.chartNote}>
        {change === 0n
          ? "Flat across the window."
          : <>{change > 0n ? "Grew" : "Shrank"} by {formatMoney((change < 0n ? -change : change).toString(), format)} over {daily.length} days.</>}
      </p>
      <svg
        className={styles.plot}
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="img"
        aria-label={`Money supply over the last ${daily.length} days`}
      >
        {points.map((point, i) => (
          <g key={daily[i]?.day ?? i}>
            <title>{`${shortDay(daily[i]?.day ?? "")} · supply ${formatMoney(series[i] ?? "0", format)}`}</title>
            <rect className={styles.hit} x={(points.length === 1 ? 0 : i * (PLOT.width / Math.max(1, points.length - 1))) - 2} y={0} width={4} height={PLOT.height} />
          </g>
        ))}
        <path className={styles.line} d={sparklinePath(points)} vectorEffect="non-scaling-stroke" />
        <line
          className={styles.baseline} vectorEffect="non-scaling-stroke"
          x1="0" y1={PLOT.height} x2={PLOT.width} y2={PLOT.height}
        />
      </svg>
      <div className={styles.axis}>
        <span>{shortDay(daily[0]?.day ?? "")}</span>
        <span>today</span>
      </div>
    </div>
  );
}

export function AdminEconomy(): JSX.Element {
  const overview = useAdminEconomyOverview();

  if (overview.isLoading) return <Loading what="the economy overview" />;
  if (overview.data === undefined) {
    return <ErrorText error={overview.error ?? new Error("no economy overview")} />;
  }

  const { supply, windows, flows, daily } = overview.data;

  // Biggest mover each way: flows is |net|-ordered, so the first row matching
  // each sign wins; an all-sink (or all-faucet) week leaves the other tile to
  // the window total instead of inventing a zero.
  const topFaucet = flows.find((f) => !f.net.startsWith("-") && f.net !== "0");
  const topSink = flows.find((f) => f.net.startsWith("-"));

  return (
    <>
      <ErrorText error={overview.error} />

      <Panel title="Economy">
        <div className={styles.hero}>
          <span className={styles.heroLabel}>Money supply</span>
          <span className={styles.heroValue}><Money value={supply.moneySupply} /></span>
          <span className={styles.heroNote}>
            Player and gang cash + bank. Points ({" "}
            <Money value={supply.points} /> ) are minted, not money.
          </span>
        </div>

        <div className={styles.tiles}>
          <Tile label="Net · last 7 days"><SignedMoney value={windows.d7.net} /></Tile>
          <Tile label="Net · last 30 days"><SignedMoney value={windows.d30.net} /></Tile>
          <Tile label="Biggest faucet · 7 days">
            {topFaucet === undefined ? "—" : <>{topFaucet.reason} <SignedMoney value={topFaucet.net} /></>}
          </Tile>
          <Tile label="Biggest sink · 7 days">
            {topSink === undefined ? "—" : <>{topSink.reason} <SignedMoney value={topSink.net} /></>}
          </Tile>
        </div>

        <details className={styles.breakdown}>
          <summary className={styles.muted}>Supply breakdown</summary>
          <table className={styles.table}>
            <thead>
              <tr><th>Where</th><th className={styles.numeric}>Amount</th></tr>
            </thead>
            <tbody>
              <tr><td>Player cash</td><td className={styles.numeric}><Money value={supply.playerCash} /></td></tr>
              <tr><td>Player bank</td><td className={styles.numeric}><Money value={supply.playerBank} /></td></tr>
              <tr><td>Gang cash</td><td className={styles.numeric}><Money value={supply.gangCash} /></td></tr>
              <tr><td>Gang bank</td><td className={styles.numeric}><Money value={supply.gangBank} /></td></tr>
            </tbody>
          </table>
        </details>
      </Panel>

      <Panel title={`The last ${daily.length} days`}>
        <div className={styles.charts}>
          <DailyNetChart daily={daily} />
          <SupplyChart supplyNow={supply.moneySupply} daily={daily} />
        </div>
      </Panel>

      <Panel title="Flows by reason · last 7 days">
        <p className={styles.muted}>
          Net by reason is the faucet/sink signal: transfers cancel to ~0, a
          positive net creates money, a negative net destroys it.
        </p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Reason</th>
              <th className={styles.numeric}>Net</th>
              <th className={styles.numeric}>Inflow</th>
              <th className={styles.numeric}>Outflow</th>
              <th className={styles.numeric}>Rows</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((flow) => (
              <tr key={flow.reason}>
                <td>{flow.reason}</td>
                <td className={styles.numeric}><SignedMoney value={flow.net} /></td>
                <td className={styles.numeric}><Money value={flow.inflow} /></td>
                <td className={styles.numeric}><Money value={flow.outflow} /></td>
                <td className={styles.numeric}>{flow.count.toLocaleString()}</td>
              </tr>
            ))}
            {flows.length === 0 && (
              <tr><td colSpan={5} className={styles.muted}>No money moved in the window.</td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      <p className={styles.muted}>
        Measured <When iso={overview.data.generatedAt} />. Refreshes every five minutes.
      </p>
    </>
  );
}
