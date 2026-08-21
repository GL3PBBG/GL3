import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useBounties, useMe, usePlaceBounty, useProfile } from "../api/queries.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

export function Bounties(): JSX.Element {
  const bounties = useBounties();
  const me = useMe();
  const placeBounty = usePlaceBounty();
  const [searchParams] = useSearchParams();
  const [targetUsername, setTargetUsername] = useState("");
  const [amount, setAmount] = useState("");

  // `?target=<playerId>` arrives from a profile's "Place bounty" link
  // (core.profileView, bounties' contribution). The form takes a username,
  // not an id, so resolve it once the profile fetch settles rather than
  // stuffing a UUID into the input.
  const targetPlayerId = searchParams.get("target");
  const targetProfile = useProfile(targetPlayerId ?? "", targetPlayerId !== null);
  useEffect(() => {
    if (targetPlayerId && targetProfile.data) setTargetUsername(targetProfile.data.username);
  }, [targetPlayerId, targetProfile.data]);

  if (bounties.isLoading) return <Loading what="bounties" />;
  if (bounties.error) return <ErrorText error={bounties.error} />;

  const rows = bounties.data?.bounties ?? [];
  const valid = targetUsername.length >= 1 && /^\d+$/.test(amount) && BigInt(amount) > 0n;

  return (
    <Panel title="Bounties">
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
          <span className={styles.meta}>Amount </span>
          <input
            inputMode="numeric"
            value={amount}
            placeholder="0"
            onChange={(e) => setAmount(e.target.value.trim())}
            aria-label="Amount"
          />
        </label>
        <button
          type="button"
          disabled={!valid || placeBounty.isPending}
          onClick={() => {
            if (!valid) return;
            placeBounty.mutate({ targetUsername, amount }, {
              onSuccess: () => { setTargetUsername(""); setAmount(""); },
            });
          }}
        >
          Place bounty
        </button>
      </div>
      {amount !== "" && !/^\d+$/.test(amount) ? (
        <p role="alert" className={styles.bad}>Whole numbers above zero only.</p>
      ) : null}
      <ErrorText error={placeBounty.error} />

      <h3 className={styles.meta}>Open bounties</h3>
      {rows.length === 0 ? (
        <p className={styles.meta}>Nobody is marked. Change that.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((bounty) => (
            <li key={bounty.id} className={styles.row}>
              <span>
                <PlayerLink playerId={bounty.targetPlayerId} username={bounty.targetUsername} />
                {bounty.targetRank ? <span className={styles.muted}> · {bounty.targetRank}</span> : null}
                {" · "}<Money value={bounty.amount} />
                <span className={styles.muted}>
                  {" · placed by "}
                  {bounty.placerUsername === me.data?.username
                    ? "you"
                    : <PlayerLink playerId={bounty.placerPlayerId} username={bounty.placerUsername} />}
                </span>
              </span>
              <span className={styles.meta}><When iso={bounty.createdAt} /></span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
