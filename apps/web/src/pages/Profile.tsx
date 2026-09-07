import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProfileDto, UpdateProfileRequest } from "@gl3/shared";
import { useChangePassword, useDeleteAccount, useMe, useProfile, useUpdateProfile } from "@gl3/client";
import { MarkdownEditor } from "../components/MarkdownEditor.js";
import { ProfileCard } from "../components/ProfileCard.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";
import { canDelete, nextDeleteStep, type DeleteStep } from "../lib/dangerZone.js";
import styles from "./pages.module.css";

export function Profile(): JSX.Element {
  const me = useMe();
  if (!me.data) return <Loading />;
  return <OwnProfile playerId={me.data.playerId} />;
}

function OwnProfile({ playerId }: { playerId: string }): JSX.Element {
  const profile = useProfile(playerId);

  if (profile.isLoading) return <Loading what="your profile" />;
  if (!profile.data) {
    return <Panel title="Profile"><ErrorText error={profile.error} /></Panel>;
  }
  return (
    <>
      <ProfileCard profile={profile.data} />
      {/* Keyed on the loaded profile so the form's state is seeded from it
          once and then owned by the player — a refetch mid-edit must not
          overwrite what they are typing. */}
      <EditProfile key={profile.data.playerId} viewerId={playerId} profile={profile.data} />
      <ChangePassword />
      <DangerZone />
    </>
  );
}

function EditProfile({ viewerId, profile }: { viewerId: string; profile: ProfileDto }): JSX.Element {
  const update = useUpdateProfile(viewerId);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl ?? "");

  const submit = (): void => {
    // `bio` always goes, which is what satisfies the schema's "at least one
    // of bio or avatarUrl" refinement even when the avatar is untouched.
    // `avatarUrl` only goes when non-empty: the schema parses it with `new
    // URL`, so "" is a 400, not a clear.
    const input: UpdateProfileRequest = avatarUrl === "" ? { bio } : { bio, avatarUrl };
    update.mutate(input);
  };

  return (
    <Panel title="Edit profile">
      <div className={styles.stack}>
        <div className={styles.field}>
          <span className={styles.meta}>Bio</span>
          <MarkdownEditor maxLength={1000} value={bio} onChange={setBio} />
        </div>
        <label className={styles.field}>
          <span className={styles.meta}>Avatar URL (http or https)</span>
          <input
            type="url"
            maxLength={500}
            placeholder="https://…"
            value={avatarUrl}
            onChange={(event) => { setAvatarUrl(event.target.value.trim()); }}
          />
        </label>
        <div className={styles.actions}>
          <button type="button" disabled={update.isPending} onClick={submit}>Save</button>
          <span className={styles.ok} role="status">
            {update.isSuccess && !update.isPending ? "Saved." : null}
          </span>
        </div>
      </div>
      <p className={styles.meta}>Leaving the avatar blank keeps the current one — it can be replaced but not removed.</p>
      <ErrorText error={update.error} />
    </Panel>
  );
}

function ChangePassword(): JSX.Element {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const submit = (): void => {
    setValidation(null);
    if (next.length < 8) { setValidation("New password must be at least 8 characters."); return; }
    if (next !== confirm) { setValidation("Passwords don't match."); return; }
    change.mutate({ currentPassword: current, newPassword: next }, { onSuccess: () => { setCurrent(""); setNext(""); setConfirm(""); } });
  };
  return (
    <Panel title="Change password">
      <div className={styles.stack}>
        <input type="password" placeholder="Current password" aria-label="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input type="password" placeholder="New password" aria-label="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <input type="password" placeholder="Confirm new password" aria-label="Confirm new password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <div className={styles.actions}>
          <button type="button" disabled={change.isPending || !current || !next || !confirm} onClick={submit}>Change password</button>
          <span className={styles.ok} role="status">{change.isSuccess && !change.isPending ? "Password changed. Other devices were signed out." : null}</span>
        </div>
        {validation ? <p role="alert" className={styles.bad}>{validation}</p> : <ErrorText error={change.error} />}
      </div>
    </Panel>
  );
}

function DangerZone(): JSX.Element {
  const navigate = useNavigate();
  // onDeleted, not a call-site mutate() onSuccess: deletion resets the query
  // cache, which unmounts this component (App flips to its logged-out
  // branch) before react-query would otherwise call a call-site callback —
  // see the doc comment on useDeleteAccount.
  const remove = useDeleteAccount({
    onDeleted: () => { navigate("/login", { state: { accountDeleted: true } }); },
  });
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<DeleteStep>("idle");
  const press = (): void => {
    const next = nextDeleteStep(step);
    setStep(next);
    if (next === "fire") {
      remove.mutate({ password }, {
        onError: () => { setStep("idle"); },
      });
    }
  };
  return (
    <Panel title="Danger zone">
      <div className={`${styles.stack} ${styles.danger}`}>
        <p className={styles.meta}>
          Deleting your account removes it and its data immediately and cannot be undone. Your gang loses you, your properties are released, and your name leaves the hall of fame.
          See the <Link to="/privacy">Privacy Policy</Link> for what is kept.
        </p>
        <input type="password" placeholder="Your password" aria-label="Your password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setStep("idle"); }} />
        <div className={styles.actions}>
          <button type="button" className={step === "armed" ? styles.dangerButton : undefined} disabled={!canDelete(password, step) || remove.isPending} onClick={press}>
            {step === "armed" ? "Yes, delete everything" : "Delete my account"}
          </button>
          {step === "armed" ? <button type="button" onClick={() => setStep("idle")}>Cancel</button> : null}
        </div>
        <ErrorText error={remove.error} />
      </div>
    </Panel>
  );
}
