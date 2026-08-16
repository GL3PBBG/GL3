import { useMe, useProperties, useBuyProperty, useClaimProperty, useSellProperty } from "../api/queries.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";
import type { PropertyRow } from "@gl3/shared";

export function rowAction(
  row: PropertyRow,
  viewerUsername: string | undefined,
): { kind: "buy" } | { kind: "owned"; accrued: string } | { kind: "none" } {
  if (row.ownerName === "—") return { kind: "buy" };
  if (viewerUsername !== undefined && row.ownerName === viewerUsername) {
    return { kind: "owned", accrued: row.accrued };
  }
  return { kind: "none" };
}

export function Properties(): JSX.Element {
  const properties = useProperties();
  const me = useMe();
  const buy = useBuyProperty();
  const claim = useClaimProperty();
  const sell = useSellProperty();

  if (properties.isLoading) return <Loading what="properties" />;
  if (properties.error) return <ErrorText error={properties.error} />;

  const rows = properties.data?.rows ?? [];

  return (
    <Panel title="Properties">
      <h3 className={styles.meta}>World properties</h3>
      {rows.length === 0 ? (
        <p className={styles.meta}>No properties available.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => {
            const action = rowAction(row, me.data?.username);
            return (
              <li key={row.id} className={styles.row}>
                <span>
                  {row.locationName}
                  <span className={styles.muted}> &middot; {row.pluginId}</span>
                  <span className={styles.muted}> &middot; rate <Money value={row.rate} />/hr</span>
                  {action.kind === "buy" ? (
                    <span className={styles.muted}> &middot; cost <Money value={row.cost} /></span>
                  ) : null}
                  {action.kind === "owned" ? (
                    <span className={styles.muted}> &middot; accrued <Money value={action.accrued} /></span>
                  ) : null}
                  {" "}&middot; owner {row.ownerName}
                </span>
                {action.kind === "buy" ? (
                  <button
                    type="button"
                    disabled={buy.isPending}
                    onClick={() => buy.mutate(row.id)}
                  >
                    Buy
                  </button>
                ) : null}
                {action.kind === "owned" ? (
                  <>
                    <button
                      type="button"
                      disabled={claim.isPending}
                      onClick={() => claim.mutate(row.id)}
                    >
                      Claim
                    </button>
                    <button
                      type="button"
                      disabled={sell.isPending}
                      onClick={() => sell.mutate(row.id)}
                    >
                      Sell
                    </button>
                  </>
                ) : null}
                <ErrorText error={buy.isError && buy.variables === row.id ? buy.error : undefined} />
                <ErrorText error={claim.isError && claim.variables === row.id ? claim.error : undefined} />
                <ErrorText error={sell.isError && sell.variables === row.id ? sell.error : undefined} />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
