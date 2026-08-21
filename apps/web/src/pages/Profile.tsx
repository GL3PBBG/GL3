import { useState } from "react";
import type { ProfileDto, UpdateProfileRequest } from "@gl3/shared";
import { useMe, useProfile, useUpdateProfile } from "../api/queries.js";
import { MarkdownEditor } from "../components/MarkdownEditor.js";
import { ProfileCard } from "../components/ProfileCard.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";
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
