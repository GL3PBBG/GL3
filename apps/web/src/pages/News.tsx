import { useNews } from "@gl3/client";
import { Markdown } from "../components/Markdown.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { ErrorText, Loading, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

/**
 * Read-only by design: `POST /api/news` is gated by hasModuleAccess and no
 * endpoint reports whether a player holds that role, so a composer here could
 * only ever be a button that 403s. Posting stays an ops action until a
 * role-management endpoint exists.
 */
export function News(): JSX.Element {
  const news = useNews();

  return (
    <Panel title="News">
      {news.isLoading ? <Loading what="the news" /> : null}
      <ErrorText error={news.error} />

      {news.data?.news.length === 0 ? <p className={styles.muted}>Nothing has happened yet.</p> : null}

      <div className={styles.stack}>
        {news.data?.news.map((item) => (
          <article key={item.id}>
            <h3>{item.title}</h3>
            <p className={styles.meta}>
              {item.authorId !== null && item.authorName !== null
                ? <PlayerLink playerId={item.authorId} username={item.authorName} />
                : "The management"}
              {" · "}<When iso={item.createdAt} />
            </p>
            <Markdown text={item.body} />
          </article>
        ))}
      </div>
    </Panel>
  );
}
