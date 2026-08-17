import { useState } from "react";
import {
  useMe, useProperties, useBuyProperty,
  useSetLever, useTransferProperty, useDropProperty, useResetProperty,
} from "../api/queries.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";
import type { PropertyRow } from "@gl3/shared";

export function rowAction(
  row: PropertyRow,
  viewerUsername: string | undefined,
):
  | { kind: "buy"; price: string }
  | { kind: "owned"; lever: string; profit: string; leverLabel: string }
  | { kind: "none" } {
  if (viewerUsername !== undefined && row.ownerName === viewerUsername) {
    return { kind: "owned", lever: row.lever, profit: row.profit, leverLabel: row.leverLabel };
  }
  // "" price means the row's type is not installed — nothing to buy.
  if (row.ownerName === "—" && row.price !== "") return { kind: "buy", price: row.price };
  return { kind: "none" };
}

/** Mirrors the server's `NonNegativeIntegerString`: digits only. */
function isValidLever(raw: string): boolean {
  return /^\d+$/.test(raw);
}

function OwnedControls({
  propertyId, leverLabel, lever, profit,
}: { propertyId: string; leverLabel: string; lever: string; profit: string }): JSX.Element {
  const setLever = useSetLever(propertyId);
  const transfer = useTransferProperty(propertyId);
  const drop = useDropProperty(propertyId);
  const reset = useResetProperty(propertyId);
  const [leverValue, setLeverValue] = useState(lever);
  const [username, setUsername] = useState("");
  const validLever = isValidLever(leverValue);
  const validUsername = username.length >= 1;

  return (
    <span className={styles.actions}>
      <span className={styles.meta}>P&amp;L <Money value={profit} /></span>
      <label>
        <span className={styles.meta}>{leverLabel} </span>
        <input
          inputMode="numeric"
          value={leverValue}
          onChange={(e) => { setLeverValue(e.target.value.trim()); }}
          aria-label={leverLabel}
        />
      </label>
      <button
        type="button"
        disabled={!validLever || setLever.isPending}
        onClick={() => setLever.mutate(leverValue)}
      >
        Set
      </button>
      <input
        maxLength={30}
        value={username}
        placeholder="Transfer to"
        onChange={(e) => { setUsername(e.target.value.trim()); }}
        aria-label="Transfer to username"
      />
      <button
        type="button"
        disabled={!validUsername || transfer.isPending}
        onClick={() => transfer.mutate(username, { onSuccess: () => { setUsername(""); } })}
      >
        Transfer
      </button>
      <button type="button" disabled={drop.isPending} onClick={() => drop.mutate()}>
        Drop
      </button>
      <button type="button" disabled={reset.isPending} onClick={() => reset.mutate()}>
        Reset
      </button>
      <ErrorText error={setLever.error ?? transfer.error ?? drop.error ?? reset.error} />
    </span>
  );
}

export function Properties(): JSX.Element {
  const properties = useProperties();
  const me = useMe();
  const buy = useBuyProperty();

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
            const buyingThisRow =
              buy.variables?.pluginId === row.pluginId && buy.variables?.locationId === row.locationId;
            return (
              <li key={row.id} className={styles.row}>
                <span>
                  {row.typeName}
                  <span className={styles.muted}> &middot; {row.locationName}</span>
                  {action.kind === "buy" ? (
                    <span className={styles.muted}> &middot; <Money value={action.price} /></span>
                  ) : null}
                  {" "}&middot; owner {row.ownerName}
                </span>
                {action.kind === "buy" ? (
                  <button
                    type="button"
                    disabled={buy.isPending}
                    onClick={() => buy.mutate({ pluginId: row.pluginId, locationId: row.locationId })}
                  >
                    Buy
                  </button>
                ) : null}
                {action.kind === "owned" ? (
                  <OwnedControls
                    propertyId={row.id}
                    leverLabel={action.leverLabel}
                    lever={action.lever}
                    profit={action.profit}
                  />
                ) : null}
                <ErrorText error={buy.isError && buyingThisRow ? buy.error : undefined} />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
