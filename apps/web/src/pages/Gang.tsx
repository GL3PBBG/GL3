import { useState } from "react";
import {
  GangPermissionSchema,
  type CreateGangRequest, type GangDto, type GangMemberDto, type GangPermission,
} from "@gl3/shared";
import {
  useAcceptInvite, useCreateGang, useDeclineInvite, useGang, useGangBank, useGangInvites,
  useGangLogs, useGangMembers, useGrantPermission, useInvitePlayer, useKickMember,
  useLeaveGang, useMe, useProfile, useRevokePermission, useTransferBoss,
} from "../api/queries.js";
import { canGrant, canInvite, canKick, canTransfer, canWithdraw, memberOf } from "../lib/gang.js";
import { canAfford } from "../lib/money.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";
import { GameImage } from "../components/GameImage.js";
import { Markdown } from "../components/Markdown.js";
import { MarkdownEditor } from "../components/MarkdownEditor.js";
import { PlayerLink } from "../components/PlayerLink.js";

const PERMISSIONS: readonly GangPermission[] = GangPermissionSchema.options;

/** Mirrors MoneySchema + the routes' amount_must_be_positive check. */
function isValidAmount(raw: string): boolean {
  return /^\d+$/.test(raw) && BigInt(raw) > 0n;
}

export function Gang(): JSX.Element {
  const me = useMe();
  if (!me.data) return <Loading />;
  return <GangFor viewerId={me.data.playerId} />;
}

/**
 * `/api/auth/me` carries no gangId, so which of the two screens to show comes
 * from the viewer's own profile — the one endpoint that reports membership.
 */
function GangFor({ viewerId }: { viewerId: string }): JSX.Element {
  const profile = useProfile(viewerId);

  if (profile.isLoading) return <Loading what="your gang" />;
  if (!profile.data) return <Panel title="Gang"><ErrorText error={profile.error} /></Panel>;

  const gangId = profile.data.gangId;
  return (
    <>
      {gangId === null ? <CreateGang viewerId={viewerId} /> : <GangHome gangId={gangId} viewerId={viewerId} />}
      <Invites viewerId={viewerId} inGang={gangId !== null} />
    </>
  );
}

/* ------------------------------------------------------------------- no gang */

function CreateGang({ viewerId }: { viewerId: string }): JSX.Element {
  const create = useCreateGang(viewerId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Mirrors CreateGangRequestSchema, whose regex is an allowlist — a rejected
  // character should say so here rather than come back as invalid_request.
  const valid = name.length >= 3 && name.length <= 50 && /^[A-Za-z0-9 _'-]+$/.test(name);

  const submit = (): void => {
    if (!valid) return;
    const input: CreateGangRequest = description === "" ? { name } : { name, description };
    create.mutate(input);
  };

  return (
    <Panel title="Start a gang">
      <p className={styles.muted}>
        You aren't in a gang. Found one, or wait for an invite — gangs can't be browsed.
      </p>
      <div className={styles.stack}>
        <label className={styles.field}>
          <span className={styles.meta}>Name</span>
          <input maxLength={50} value={name} onChange={(event) => { setName(event.target.value); }} />
        </label>
        <div className={styles.field}>
          <span className={styles.meta}>Description (optional)</span>
          <MarkdownEditor maxLength={500} value={description} onChange={setDescription} />
        </div>
        <div className={styles.actions}>
          <button type="button" disabled={!valid || create.isPending} onClick={submit}>Found gang</button>
        </div>
      </div>
      {name !== "" && !valid ? (
        <p role="alert" className={styles.bad}>3–50 characters: letters, digits, spaces, and _ - &apos; only.</p>
      ) : null}
      <ErrorText error={create.error} />
    </Panel>
  );
}

/**
 * Invites are not pruned when the invitee joins somewhere else, so a viewer who
 * already has a gang can be holding one that would answer 409 already_in_a_gang.
 * It is still listed — declining is the way to clear it — with Accept disabled
 * and the reason on screen rather than left for the player to discover.
 */
function Invites({ viewerId, inGang }: { viewerId: string; inGang: boolean }): JSX.Element | null {
  const invites = useGangInvites();
  const accept = useAcceptInvite(viewerId);
  const decline = useDeclineInvite();

  if (invites.data && invites.data.invites.length === 0) return null;

  return (
    <Panel title="Invites">
      {invites.isLoading ? <Loading what="your invites" /> : null}
      <ErrorText error={invites.error} />
      <ErrorText error={accept.error} />
      <ErrorText error={decline.error} />

      <ul className={styles.rows}>
        {invites.data?.invites.map((invite) => (
          <li key={invite.id} className={styles.row}>
            <span className={styles.rowStack}>
              <span>{invite.gangName}</span>
              <span className={styles.meta}>
                from <PlayerLink playerId={invite.invitedByPlayerId} username={invite.invitedByUsername} /> · <When iso={invite.createdAt} />
              </span>
            </span>
            <span className={styles.actions}>
              <button
                type="button"
                disabled={inGang || accept.isPending}
                title={inGang ? "Leave your gang first." : undefined}
                onClick={() => { accept.mutate(invite.id); }}
              >
                Accept
              </button>
              <button
                type="button"
                disabled={decline.isPending}
                onClick={() => { decline.mutate(invite.id); }}
              >
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
      {inGang ? <p className={styles.meta}>You're already in a gang — leave it before accepting another invite.</p> : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ in a gang */

function GangHome({ gangId, viewerId }: { gangId: string; viewerId: string }): JSX.Element {
  const gang = useGang(gangId);
  const members = useGangMembers(gangId);
  const logs = useGangLogs(gangId);

  const roster = members.data?.members ?? [];
  const viewer = memberOf(roster, viewerId);

  if (!gang.data) {
    return (
      <Panel title="Gang">
        {gang.isLoading ? <Loading what="your gang" /> : null}
        <ErrorText error={gang.error} />
      </Panel>
    );
  }

  return (
    <>
      <Summary gang={gang.data} viewer={viewer} gangId={gangId} viewerId={viewerId} />
      <GangBank gangId={gangId} gang={gang.data} viewer={viewer} />
      <Roster
        gangId={gangId}
        viewerId={viewerId}
        viewer={viewer}
        roster={roster}
        loading={members.isLoading}
        error={members.error}
      />
      {canInvite(viewer) ? <InviteForm gangId={gangId} /> : null}
      <Panel title="Gang log">
        {logs.isLoading ? <Loading what="the log" /> : null}
        <ErrorText error={logs.error} />
        <ul className={styles.rows}>
          {logs.data?.logs.map((log) => (
            <li key={log.id} className={styles.row}>
              <span>{log.message}</span>
              <span className={styles.meta}><When iso={log.createdAt} /></span>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function Summary({
  gang, viewer, gangId, viewerId,
}: {
  gang: GangDto; viewer: GangMemberDto | undefined; gangId: string; viewerId: string;
}): JSX.Element {
  const leave = useLeaveGang(gangId, viewerId);
  // The server answers 409 boss_must_transfer_first; say so up front instead.
  const isBoss = viewer?.role === "boss";

  return (
    <Panel title={gang.name}>
      <GameImage url={gang.imageUrl} alt={`${gang.name} crest`} size="lg" />
      <p className={styles.meta}>
        Level {gang.level} · {gang.memberCount} member{gang.memberCount === 1 ? "" : "s"}
      </p>
      {gang.description === "" ? null : <Markdown text={gang.description} />}
      {gang.info === "" ? null : <Markdown text={gang.info} />}
      <p className={styles.big}><Money value={gang.bank} /></p>
      <p className={styles.meta}><Money value={gang.cash} /> on hand.</p>

      <div className={styles.actions}>
        <button
          type="button"
          disabled={isBoss || leave.isPending}
          title={isBoss ? "Hand the gang over first." : undefined}
          onClick={() => { leave.mutate(); }}
        >
          Leave gang
        </button>
        {isBoss ? <span className={styles.meta}>A boss must transfer leadership before leaving.</span> : null}
      </div>
      <ErrorText error={leave.error} />
    </Panel>
  );
}

function GangBank({
  gangId, gang, viewer,
}: { gangId: string; gang: GangDto; viewer: GangMemberDto | undefined }): JSX.Element {
  const me = useMe();
  const bank = useGangBank(gangId);
  const [amount, setAmount] = useState("");

  const valid = isValidAmount(amount);
  const check = valid ? amount : "0";
  const submit = (direction: "deposit" | "withdraw"): void => {
    if (!valid) return;
    bank.mutate({ direction, amount }, { onSuccess: () => { setAmount(""); } });
  };

  return (
    <Panel title="Gang bank">
      <div className={styles.form}>
        <label>
          <span className={styles.meta}>Amount </span>
          <input
            inputMode="numeric"
            value={amount}
            placeholder="0"
            onChange={(event) => { setAmount(event.target.value.trim()); }}
          />
        </label>
        <button
          type="button"
          disabled={!valid || bank.isPending || !canAfford(me.data?.cash ?? "0", check)}
          onClick={() => { submit("deposit"); }}
        >
          Deposit
        </button>
        <button
          type="button"
          disabled={!valid || bank.isPending || !canWithdraw(viewer) || !canAfford(gang.bank, check)}
          title={canWithdraw(viewer) ? undefined : "You don't have the bank.withdraw permission."}
          onClick={() => { submit("withdraw"); }}
        >
          Withdraw
        </button>
      </div>
      {amount !== "" && !valid ? (
        <p role="alert" className={styles.bad}>Whole numbers above zero only.</p>
      ) : null}
      <ErrorText error={bank.error} />
    </Panel>
  );
}

function Roster({
  gangId, viewerId, viewer, roster, loading, error,
}: {
  gangId: string;
  viewerId: string;
  viewer: GangMemberDto | undefined;
  roster: readonly GangMemberDto[];
  loading: boolean;
  error: unknown;
}): JSX.Element {
  const kick = useKickMember(gangId);
  const transfer = useTransferBoss(gangId);
  const grant = useGrantPermission(gangId);
  const revoke = useRevokePermission(gangId);

  return (
    <Panel title="Members">
      {loading ? <Loading what="the roster" /> : null}
      <ErrorText error={error} />
      <ErrorText error={kick.error} />
      <ErrorText error={transfer.error} />
      <ErrorText error={grant.error} />
      <ErrorText error={revoke.error} />

      <ul className={styles.rows}>
        {roster.map((member) => (
          <li
            key={member.playerId}
            className={member.playerId === viewerId ? `${styles.row} ${styles.rowCurrent}` : styles.row}
          >
            <span className={styles.rowStack}>
              <span>
                <PlayerLink playerId={member.playerId} username={member.username} />
                {" · "}
                <span className={styles.meta}>{member.role}</span>
              </span>
              <span className={styles.meta}>joined <When iso={member.joinedAt} /></span>
              <Permissions
                member={member}
                editable={canGrant(viewer) && member.role === "member"}
                busy={grant.isPending || revoke.isPending}
                onGrant={(permission) => { grant.mutate({ playerId: member.playerId, permission }); }}
                onRevoke={(permission) => { revoke.mutate({ playerId: member.playerId, permission }); }}
              />
            </span>
            <span className={styles.actions}>
              {canTransfer(viewer, member) ? (
                <button
                  type="button"
                  disabled={transfer.isPending}
                  onClick={() => { transfer.mutate(member.playerId); }}
                >
                  Make boss
                </button>
              ) : null}
              {canKick(viewer, member) ? (
                <button
                  type="button"
                  disabled={kick.isPending}
                  onClick={() => { kick.mutate(member.playerId); }}
                >
                  Kick
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Leadership's permissions arrive already expanded to the full list and have no
 * `gang_permissions` rows behind them, so they render as plain chips — there is
 * nothing there to revoke. Only a plain member's grants are editable.
 */
function Permissions({
  member, editable, busy, onGrant, onRevoke,
}: {
  member: GangMemberDto;
  editable: boolean;
  busy: boolean;
  onGrant: (permission: GangPermission) => void;
  onRevoke: (permission: GangPermission) => void;
}): JSX.Element | null {
  if (!editable) {
    if (member.permissions.length === 0) return null;
    return (
      <span className={styles.chips}>
        {member.permissions.map((permission) => (
          <span key={permission} className={styles.chip}>{permission}</span>
        ))}
      </span>
    );
  }

  return (
    <span className={styles.chips}>
      {PERMISSIONS.map((permission) => {
        const held = member.permissions.includes(permission);
        return (
          <button
            key={permission}
            type="button"
            aria-pressed={held}
            className={held ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            disabled={busy}
            onClick={() => { (held ? onRevoke : onGrant)(permission); }}
          >
            {permission}
          </button>
        );
      })}
    </span>
  );
}

function InviteForm({ gangId }: { gangId: string }): JSX.Element {
  const invite = useInvitePlayer(gangId);
  const [username, setUsername] = useState("");
  const valid = username.length >= 3 && username.length <= 30;

  return (
    <Panel title="Invite a player">
      <div className={styles.form}>
        <label>
          <span className={styles.meta}>Username </span>
          <input
            maxLength={30}
            value={username}
            onChange={(event) => { setUsername(event.target.value.trim()); }}
          />
        </label>
        <button
          type="button"
          disabled={!valid || invite.isPending}
          onClick={() => {
            if (!valid) return;
            invite.mutate(username, { onSuccess: () => { setUsername(""); } });
          }}
        >
          Invite
        </button>
      </div>
      {/* Always-mounted live region: inserted-with-content regions are often not announced. */}
      <p className={styles.ok} role="status">
        {invite.isSuccess && !invite.isPending ? "Invite sent." : null}
      </p>
      <ErrorText error={invite.error} />
    </Panel>
  );
}
