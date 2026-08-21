import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { DetectiveSearchRow } from "@gl3/shared";
import { useDetectives, useHireDetectives, useProfile, useRemoveDetectiveSearch } from "../api/queries.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import { PlayerLink } from "../components/PlayerLink.js";
import styles from "./pages.module.css";

const UNITS = [1, 2, 3, 4, 5] as const;

/**
 * The 1–5 dropdown is a unit count; the server says how many real seconds one
 * unit lasts (V2's detectiveDuration). Label each option with its real span —
 * "1 hour" at 3600, "1 second" at V2's shipped default of 1 — the way V2 fed
 * i × detectiveDuration through timeElapsedString().
 */
function spanLabel(units: number, secondsPerUnit: number): string {
  const total = units * secondsPerUnit;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (total % 3600 === 0) return plural(total / 3600, "hour");
  if (total % 60 === 0) return plural(total / 60, "minute");
  return plural(total, "second");
}

/** pending | failed | succeeded-expired | succeeded-active — spec §3's states. */
function rowState(row: DetectiveSearchRow, nowMs: number): "pending" | "failed" | "expired" | "active" {
  if (row.succeeded === null) return "pending";
  if (row.succeeded === false) return "failed";
  // Guard on targetLocationName so client-clock skew (client ahead of
  // server) degrades to expired rendering instead of "spotted in ".
  return nowMs < Date.parse(row.expiresAt) && row.targetLocationName !== null
    ? "active" : "expired";
}

function SearchRow({ row }: { row: DetectiveSearchRow }): JSX.Element {
  const removeSearch = useRemoveDetectiveSearch();
  const state = rowState(row, Date.now());
  return (
    <li className={styles.row}>
      <span>
        {row.detectives} detective{row.detectives === 1 ? "" : "s"} on{" "}
        <PlayerLink playerId={row.targetId} username={row.targetUsername} />
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
  const [searchParams] = useSearchParams();
  const [targetUsername, setTargetUsername] = useState("");
  const [dets, setDets] = useState(1);
  const [hours, setHours] = useState(1);

  // `?target=<playerId>` arrives from a profile's "Hire detective" link
  // (core.profileView, detectives' contribution). The form takes a
  // username, not an id, so resolve it once the profile fetch settles
  // rather than stuffing a UUID into the input (Bounties.tsx's pattern).
  const targetPlayerId = searchParams.get("target");
  const targetProfile = useProfile(targetPlayerId ?? "", targetPlayerId !== null);
  useEffect(() => {
    if (targetPlayerId && targetProfile.data) setTargetUsername(targetProfile.data.username);
  }, [targetPlayerId, targetProfile.data]);

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
          <span className={styles.meta}>Duration </span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Duration">
            {UNITS.map((n) => (
              <option key={n} value={n}>
                {spanLabel(n, detectives.data?.durationSeconds ?? 3600)}
              </option>
            ))}
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
