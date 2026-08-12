import { useState } from "react";
import {
  useOc, useCreateHeist, useInvite, useAccept, useDecline,
  useLeave, useCancel, useExecute, useMe,
} from "../api/queries.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

const ROLES = ["mastermind", "driver", "gunman", "hacker"] as const;

/** Map members to a lookup keyed by role for the slot grid. */
function slotMap(members: readonly { role: string; playerId: string; state: string; username: string }[]) {
  const map = new Map<string, { playerId: string; state: string; username: string }>();
  for (const m of members) map.set(m.role, m);
  return map;
}

export function OrganizedCrime(): JSX.Element {
  const oc = useOc();
  const me = useMe();
  const createHeist = useCreateHeist();
  const [buyIn, setBuyIn] = useState("");

  if (oc.isLoading) return <Loading what="heists" />;
  if (oc.error) return <ErrorText error={oc.error} />;

  const heist = oc.data?.heist ?? null;
  const invites = oc.data?.invites ?? [];
  const playerId = me.data?.playerId;
  const isLeader = heist !== null && playerId === heist.leaderId;
  const isMember = heist !== null && playerId !== undefined &&
    heist.members.some((m) => m.playerId === playerId);
  const canCreate = heist === null && invites.length === 0;
  const validCreate = /^\d+$/.test(buyIn) && BigInt(buyIn) > 0n;
  const slots = heist ? slotMap(heist.members) : null;

  return (
    <Panel title="Heists">
      {/* Create form — shown when not in a heist and no pending invites */}
      {canCreate ? (
        <>
          <div className={styles.form}>
            <label>
              <span className={styles.meta}>Buy-in amount </span>
              <input
                inputMode="numeric"
                value={buyIn}
                placeholder="0"
                onChange={(e) => setBuyIn(e.target.value.trim())}
                aria-label="Buy-in amount"
              />
            </label>
            <button
              type="button"
              disabled={!validCreate || createHeist.isPending}
              onClick={() => {
                if (!validCreate) return;
                createHeist.mutate({ buyIn }, {
                  onSuccess: () => { setBuyIn(""); },
                });
              }}
            >
              Create heist
            </button>
          </div>
          {buyIn !== "" && !/^\d+$/.test(buyIn) ? (
            <p role="alert" className={styles.bad}>Whole numbers above zero only.</p>
          ) : null}
          <ErrorText error={createHeist.error} />
        </>
      ) : null}

      {/* Invite cards */}
      {invites.length > 0 ? (
        <>
          <h3 className={styles.meta}>Pending invites</h3>
          <ul className={styles.rows}>
            {invites.map((inv) => (
              <InviteCard key={inv.heistId} invite={inv} onAcceptOrDecline={() => {}} />
            ))}
          </ul>
        </>
      ) : null}

      {/* Heist view */}
      {heist ? (
        <>
          <h3 className={styles.meta}>Status: {heist.status}</h3>
          {heist.status === "executing" ? (
            <p className={styles.meta}>Heist is executing...</p>
          ) : null}

          <h3 className={styles.meta}>Crew (buy-in <Money value={heist.buyIn} />)</h3>
          <ul className={styles.rows}>
            {ROLES.map((role) => {
              const member = slots?.get(role);
              return (
                <li key={role} className={styles.row}>
                  <span>
                    <strong>{role}</strong>
                    {member ? (
                      <>
                        {" — "}{member.username}
                        <span className={styles.muted}> ({member.state})</span>
                      </>
                    ) : (
                      <span className={styles.muted}> — empty</span>
                    )}
                  </span>
                  {/* Leader-only invite form for empty non-mastermind slots */}
                  {isLeader && !member && role !== "mastermind" ? (
                    <InviteForm heistId={heist.id} role={role} />
                  ) : null}
                </li>
              );
            })}
          </ul>

          {/* Leader actions */}
          {isLeader && heist.status === "open" ? (
            <div className={styles.actions}>
              <ExecuteButton heistId={heist.id} memberCount={heist.members.length} />
              <CancelButton heistId={heist.id} />
            </div>
          ) : null}

          {/* Non-leader member actions */}
          {isMember && !isLeader && heist.status === "open" ? (
            <LeaveButton heistId={heist.id} />
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InviteCard({ invite, onAcceptOrDecline }: {
  invite: { heistId: string; role: string; buyIn: string; leaderUsername: string };
  onAcceptOrDecline: () => void;
}): JSX.Element {
  const accept = useAccept(invite.heistId);
  const decline = useDecline(invite.heistId);

  return (
    <li className={styles.row}>
      <span>
        {invite.leaderUsername} invited you as <strong>{invite.role}</strong>
        {" (buy-in "}<Money value={invite.buyIn} />{")"}
      </span>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={accept.isPending}
          onClick={() => accept.mutate(undefined, { onSuccess: onAcceptOrDecline })}
        >
          Accept
        </button>
        <button
          type="button"
          disabled={decline.isPending}
          onClick={() => decline.mutate(undefined, { onSuccess: onAcceptOrDecline })}
        >
          Decline
        </button>
      </div>
      <ErrorText error={accept.error || decline.error} />
    </li>
  );
}

function InviteForm({ heistId, role }: { heistId: string; role: string }): JSX.Element {
  const invite = useInvite(heistId);
  const [username, setUsername] = useState("");
  const valid = username.length >= 1;

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        invite.mutate({ targetUsername: username, role }, {
          onSuccess: () => { setUsername(""); },
        });
      }}
    >
      <input
        maxLength={30}
        value={username}
        placeholder="Username"
        onChange={(e) => setUsername(e.target.value.trim())}
        aria-label={`Invite username for ${role}`}
      />
      <button type="submit" disabled={!valid || invite.isPending}>Invite</button>
      <ErrorText error={invite.error} />
    </form>
  );
}

function ExecuteButton({ heistId, memberCount }: { heistId: string; memberCount: number }): JSX.Element {
  const execute = useExecute(heistId);
  return (
    <button
      type="button"
      disabled={execute.isPending || memberCount < 4}
      onClick={() => execute.mutate()}
      title={memberCount < 4 ? "Need 4 crew members" : undefined}
    >
      Execute heist
    </button>
  );
}

function CancelButton({ heistId }: { heistId: string }): JSX.Element {
  const cancel = useCancel(heistId);
  return (
    <button
      type="button"
      disabled={cancel.isPending}
      onClick={() => cancel.mutate()}
    >
      Cancel heist
    </button>
  );
}

function LeaveButton({ heistId }: { heistId: string }): JSX.Element {
  const leave = useLeave(heistId);
  return (
    <button
      type="button"
      disabled={leave.isPending}
      onClick={() => leave.mutate()}
    >
      Leave heist
    </button>
  );
}
