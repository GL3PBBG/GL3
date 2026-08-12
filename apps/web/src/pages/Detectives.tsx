import { useState } from "react";
import { Link } from "react-router-dom";
import type { DetectiveSearchRow } from "@gl3/shared";
import { useDetectives, useHireDetectives, useRemoveDetectiveSearch } from "../api/queries.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

const UNITS = [1, 2, 3, 4, 5] as const;

/** pending | failed | succeeded-expired | succeeded-active — spec §3's states. */
function rowState(row: DetectiveSearchRow, nowMs: number): "pending" | "failed" | "expired" | "active" {
  if (row.succeeded === null) return "pending";
  if (row.succeeded === false) return "failed";
  return nowMs < Date.parse(row.expiresAt) ? "active" : "expired";
}

function SearchRow({ row }: { row: DetectiveSearchRow }): JSX.Element {
  const removeSearch = useRemoveDetectiveSearch();
  const state = rowState(row, Date.now());
  return (
    <li className={styles.row}>
      <span>
        {row.detectives} detective{row.detectives === 1 ? "" : "s"} on {row.targetUsername}
      </span>
      {state === "pending" ? (
        <span className={styles.meta}>
          searching — report due <When iso={row.endsAt} />
        </span>
      ) : null}
      {state === "failed" ? (
        <span className={styles.bad}>came back empty-handed</span>
      ) : null}
      {state === "expired" ? (
        <span className={styles.meta}>found them, but the trail went cold</span>
      ) : null}
      {state === "active" ? (
        <span>
          spotted in <strong>{row.targetLocationName}</strong> (live, until{" "}
          <When iso={row.expiresAt} />) <Link to="/travel">Travel there</Link>
        </span>
      ) : null}
      {state !== "pending" ? (
        <button
          type="button"
          disabled={removeSearch.isPending}
          onClick={() => removeSearch.mutate(row.id)}
        >
          Remove
        </button>
      ) : null}
      <ErrorText error={removeSearch.error} />
    </li>
  );
}

export function Detectives(): JSX.Element {
  const detectives = useDetectives();
  const hire = useHireDetectives();
  const [targetUsername, setTargetUsername] = useState("");
  const [dets, setDets] = useState(1);
  const [hours, setHours] = useState(1);

  if (detectives.isLoading) return <Loading what="detectives" />;
  if (detectives.error) return <ErrorText error={detectives.error} />;

  const rows = detectives.data?.searches ?? [];
  // Money stays a decimal string end to end — bigint math, never a JSON number.
  const totalCost = (BigInt(detectives.data?.cost ?? "0") * BigInt(dets) * BigInt(hours)).toString();
  const valid = targetUsername.length >= 1;

  return (
    <Panel title="Detectives">
      <div className={styles.form}>
        <label>
          <span className={styles.meta}>Target username </span>
          <input
            maxLength={30}
            value={targetUsername}
            onChange={(e) => setTargetUsername(e.target.value.trim())}
            aria-label="Target username"
          />
        </label>
        <label>
          <span className={styles.meta}>Detectives </span>
          <select value={dets} onChange={(e) => setDets(Number(e.target.value))} aria-label="Detectives">
            {UNITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          <span className={styles.meta}>Hours </span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Hours">
            {UNITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className={styles.meta}>
          Cost: <Money value={totalCost} /> — success chance {dets * 4 * hours}%
        </span>
        <button
          type="button"
          disabled={!valid || hire.isPending}
          onClick={() => {
            if (!valid) return;
            hire.mutate({ targetUsername, detectives: dets, hours }, {
              onSuccess: () => setTargetUsername(""),
            });
          }}
        >
          Hire
        </button>
      </div>
      <ErrorText error={hire.error} />

      <h3 className={styles.meta}>Your searches</h3>
      {rows.length === 0 ? (
        <p className={styles.meta}>No searches yet. Hire detectives to hunt a player down.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => <SearchRow key={row.id} row={row} />)}
        </ul>
      )}
    </Panel>
  );
}
