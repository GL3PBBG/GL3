import { usePlugins } from "../api/queries.js";
import { describeEvent, isSilentEvent, useEvents } from "@gl3/client";
import styles from "./EventFeed.module.css";

export function EventFeed(): JSX.Element {
  const events = useEvents();
  const plugins = usePlugins();
  const eventMetas = plugins.data?.events ?? [];
  // Filtered BEFORE the map, not skipped inside it: a silent event must not
  // occupy a list item at all, or the feed grows blank rows every time a
  // casino table ticks. The store still holds them and the WS layer still
  // invalidates on them — silence is a rendering decision and nothing else.
  const visible = events.filter((event) => !isSilentEvent(event, eventMetas));
  return (
    <aside className={styles.feed}>
      <h3 className={styles.heading}>Live feed</h3>
      {visible.length === 0 ? <p className={styles.empty}>Nothing yet.</p> : null}
      {/* role="log": for many players this list is the ONLY place a crime or
          combat outcome is ever rendered, so it must announce. "polite" queues
          behind whatever the reader is saying rather than interrupting. */}
      <ul className={styles.list} role="log" aria-live="polite">
        {visible.map((event) => (
          <li key={event.id} className={styles.item}>
            <time className={styles.time} dateTime={event.at}>
              {new Date(event.at).toLocaleTimeString()}
            </time>{" "}
            {describeEvent(event, eventMetas)}
          </li>
        ))}
      </ul>
    </aside>
  );
}
