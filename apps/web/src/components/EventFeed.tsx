import { usePlugins } from "../api/queries.js";
import { describeEvent } from "../lib/eventCopy.js";
import { useEvents } from "../store/events.js";
import styles from "./EventFeed.module.css";

export function EventFeed(): JSX.Element {
  const events = useEvents();
  const plugins = usePlugins();
  return (
    <aside className={styles.feed}>
      <h3 className={styles.heading}>Live feed</h3>
      {events.length === 0 ? <p className={styles.empty}>Nothing yet.</p> : null}
      <ul className={styles.list}>
        {events.map((event) => (
          <li key={event.id} className={styles.item}>
            <time className={styles.time} dateTime={event.at}>
              {new Date(event.at).toLocaleTimeString()}
            </time>{" "}
            {describeEvent(event, plugins.data?.events ?? [])}
          </li>
        ))}
      </ul>
    </aside>
  );
}
