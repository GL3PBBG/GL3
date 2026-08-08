import type { ProfileDto } from "@gl3/shared";
import { Amount, Avatar, Panel, When } from "./ui.js";
import styles from "../pages/pages.module.css";

/**
 * The read-only half of a profile, shared by `/profile` and `/players/:id` so
 * a player sees themselves exactly as everyone else does.
 *
 * The gang is named but not linked: there is no gang-browsing endpoint, and
 * `/gang` only ever shows the *viewer's* own gang.
 */
export function ProfileCard({ profile }: { profile: ProfileDto }): JSX.Element {
  return (
    <Panel title={profile.username}>
      <div className={styles.form}>
        <Avatar url={profile.avatarUrl} alt={`${profile.username}'s avatar`} />
        <div className={styles.rowStack}>
          <span className={styles.meta}>
            {profile.rankName ?? "Unranked"} · <Amount value={profile.exp} /> exp
          </span>
          <span className={styles.meta}>
            {profile.gangName ?? "No gang"} · joined <When iso={profile.createdAt} />
          </span>
        </div>
      </div>
      {profile.bio === null || profile.bio === "" ? (
        <p className={styles.muted}>No bio.</p>
      ) : (
        <p className={styles.prose}>{profile.bio}</p>
      )}
    </Panel>
  );
}
