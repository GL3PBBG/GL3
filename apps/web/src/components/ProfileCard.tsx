import { Link } from "react-router-dom";
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
  // `extras` is optional so a cached response from before this cluster shipped
  // still renders — no plugin subscribed to `core.profileView` is the common
  // case, not the exception, on a fresh install.
  const extras = profile.extras ?? [];
  const statExtras = extras.filter((extra) => extra.kind === "stat");
  const linkExtras = extras.filter((extra) => extra.kind === "link");

  return (
    <Panel title={profile.username}>
      <div className={styles.form}>
        <Avatar url={profile.avatarUrl} alt={`${profile.username}'s avatar`} />
        <div className={styles.rowStack}>
          <span className={styles.meta}>
            {profile.rankName ?? "Unranked"}
            {profile.moneyRankLabel !== null ? ` · ${profile.moneyRankLabel}` : ""}
            {" · "}<Amount value={profile.exp} /> exp
          </span>
          <span className={styles.meta}>
            {profile.gangName ?? "No gang"} · joined <When iso={profile.createdAt} />
          </span>
          <span className={styles.meta}>Backfires · {profile.backfire}</span>
          {statExtras.map((extra) => (
            <span key={`${extra.pluginId}:${extra.label}`} className={styles.meta}>
              {extra.label} · {extra.value}
            </span>
          ))}
        </div>
      </div>
      {profile.bio === null || profile.bio === "" ? (
        <p className={styles.muted}>No bio.</p>
      ) : (
        <p className={styles.prose}>{profile.bio}</p>
      )}
      {linkExtras.length > 0 ? (
        <div className={styles.actions}>
          {linkExtras.map((extra) => (
            <Link key={`${extra.pluginId}:${extra.label}`} to={extra.to}>{extra.label}</Link>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
