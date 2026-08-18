import { Link } from "react-router-dom";
import styles from "../pages/pages.module.css";

/** Every player name in the app routes to the profile — V2's profile links, GL3-wide. */
export function PlayerLink({ playerId, username }: { playerId: string; username: string }): JSX.Element {
  return <Link className={styles.link} to={`/players/${playerId}`}>{username}</Link>;
}
