import { Link } from "react-router-dom";
import { useDashboardWidgets, useJail, useLocations, useMe, usePlugins, useRanks } from "../api/queries.js";
import { useSentenceCountdown } from "../hooks/useSentenceCountdown.js";
import { formatAmount } from "../lib/money.js";
import { formatDuration } from "../lib/errors.js";
import { progressToNextRank } from "../lib/ranks.js";
import { Amount, Loading, Money, Panel } from "../components/ui.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import { renderNode } from "../plugins/render.js";
import styles from "./pages.module.css";

export function Dashboard(): JSX.Element {
  const me = useMe();
  const plugins = usePlugins();
  const jail = useJail();
  const ranks = useRanks();
  const locations = useLocations();
  const widgets = useDashboardWidgets();
  // Above the early return: hooks cannot be called conditionally.
  const jailSeconds = useSentenceCountdown(
    "jail", jail.data?.jailed === true ? jail.data.remainingSeconds : undefined,
    jail.dataUpdatedAt,
  );

  if (!me.data) return <Loading />;

  const progress = progressToNextRank(me.data.exp, ranks.data?.ranks ?? []);
  const here = locations.data?.locations.find((location) => location.current);

  return (
    <>
      <Panel title={me.data.username}>
        <p className={styles.big}>
          <Money value={me.data.cash} /> <span className={styles.meta}>on hand</span>
        </p>
        <p className={styles.meta}>
          Bank <Money value={me.data.bank} /> · Bullets <Amount value={me.data.bullets} /> · Exp{" "}
          <Amount value={me.data.exp} />
        </p>
      </Panel>

      <Panel title="Rank">
        <p style={{ margin: 0 }}>
          {progress.current?.name ?? "Unranked"}
          {progress.next !== null ? ` → ${progress.next.name}` : " — top of the ladder"}
        </p>
        <div className={styles.bar}>
          <div className={styles.barFill} style={{ width: `${progress.pct}%` }} />
        </div>
        <p className={styles.meta}>
          {progress.next === null
            ? `${progress.pct.toFixed(0)}%`
            : `${progress.pct.toFixed(1)}% — ${formatAmount(
                (BigInt(progress.next.expRequired) - BigInt(me.data.exp)).toString(),
              )} exp to go`}
        </p>
      </Panel>

      {/* Travel-town panel: absent entirely when the travel plugin is not
          installed (framework boot) — "Nowhere yet, travel somewhere" would
          be a dead-end suggestion on a game with no travel. */}
      {(plugins.data?.installed ?? []).includes("travel") ? (
        <Panel title="Where you are">
          {here === undefined ? (
            <p className={styles.meta}>
              Nowhere yet. <Link to="/plugins/travel.index">Travel</Link> somewhere to unlock the bullet shop.
            </p>
          ) : (
            <p style={{ margin: 0 }}>
              {here.name} — bullets at <Money value={here.bulletCost} /> each,{" "}
              {here.bulletStock} in stock. <Link to="/plugins/bullets.index">Buy</Link>
            </p>
          )}
        </Panel>
      ) : null}

      {jail.data?.jailed === true ? (
        <Panel title="Jail">
          <p className={styles.bad} style={{ margin: 0 }}>
            Locked up for another {formatDuration(jailSeconds)}.{" "}
            <Link to="/plugins/jail">Watch the clock</Link>
          </p>
        </Panel>
      ) : jail.isError ? null : (
        <Panel title="Next">
          <p style={{ margin: 0 }}>
            <Link to="/plugins/crimes.index">Commit a crime</Link> · <Link to="/bank">Bank your cash</Link> ·{" "}
            <Link to="/leaderboards">See who's winning</Link>
          </p>
        </Panel>
      )}

      {/* Plugin-contributed panels via `dashboard.widgets` (core.ts applier).
          Same renderNode + PageRenderer shape as PluginPage.tsx, keyed on
          pluginId + title so two widgets sharing a title from different
          plugins don't collide and a re-fetch doesn't drop form state across
          widgets. */}
      {(widgets.data?.widgets ?? []).map((widget) => (
        <Panel key={`${widget.pluginId}:${widget.title}`} title={widget.title}>
          <PageRenderer instructions={renderNode(widget.view, {})} />
        </Panel>
      ))}
    </>
  );
}
