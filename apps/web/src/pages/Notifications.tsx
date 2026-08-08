import { useMarkNotificationRead, useNotifications } from "../api/queries.js";
import { ErrorText, Loading, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

export function Notifications(): JSX.Element {
  const notifications = useNotifications();
  const markRead = useMarkNotificationRead();

  // Unread first, then newest first within each group. Timestamps are ISO-8601
  // UTC, so comparing the strings is comparing the instants.
  const items = [...(notifications.data?.notifications ?? [])].sort((a, b) => {
    if ((a.readAt === null) !== (b.readAt === null)) return a.readAt === null ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });

  return (
    <Panel title="Notifications">
      {notifications.isLoading ? <Loading what="your notifications" /> : null}
      <ErrorText error={notifications.error} />
      <ErrorText error={markRead.error} />

      {items.length === 0 && !notifications.isLoading
        ? <p className={styles.muted}>Nothing to read.</p>
        : null}

      <ul className={styles.rows}>
        {items.map((item) => (
          <li
            key={item.id}
            className={item.readAt === null ? `${styles.row} ${styles.unread}` : styles.row}
          >
            <span className={styles.rowStack}>
              <span>{item.body}</span>
              <span className={styles.meta}><When iso={item.createdAt} /></span>
            </span>
            {item.readAt === null ? (
              <button
                type="button"
                disabled={markRead.isPending}
                onClick={() => { markRead.mutate(item.id); }}
              >
                Mark read
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
