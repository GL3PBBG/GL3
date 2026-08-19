import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useCreateTopic, useForumTopics, useForums } from "../api/queries.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { ErrorText, Loading, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

/** The forum list — no `:forumId`. */
function ForumList(): JSX.Element {
  const forums = useForums();

  return (
    <Panel title="Forums">
      {forums.isLoading ? <Loading what="the forums" /> : null}
      <ErrorText error={forums.error} />

      {forums.data?.forums.length === 0 ? <p className={styles.muted}>No forums yet.</p> : null}

      <ul className={styles.rows}>
        {forums.data?.forums.map((forum) => (
          <li key={forum.id} className={styles.row}>
            <Link className={styles.link} to={`/forum/${forum.id}`}>{forum.name}</Link>
            <span className={styles.meta}>{forum.topicCount} topics</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** One forum's topic list — the `:forumId` case. */
function TopicList({ forumId }: { forumId: string }): JSX.Element {
  const [page, setPage] = useState(1);
  const topics = useForumTopics(forumId, page);

  const forumName = topics.data?.forumName ?? "Forum";
  const rows = topics.data?.topics ?? [];
  const pageCount = topics.data?.pageCount ?? 1;

  return (
    <>
      <Panel title={forumName}>
        <p className={styles.meta}>
          <Link className={styles.link} to="/forum">← Forums</Link>
        </p>

        {topics.isLoading ? <Loading what="topics" /> : null}
        <ErrorText error={topics.error} />

        {rows.length === 0 && !topics.isLoading
          ? <p className={styles.muted}>No topics yet — start one below.</p>
          : null}

        <ul className={styles.rows}>
          {rows.map((topic) => (
            <li key={topic.id} className={styles.row}>
              <span className={styles.rowStack}>
                <span>
                  {topic.type === "sticky" ? <span className={`${styles.chip} ${styles.chipOn}`}>Sticky</span> : null}
                  {" "}
                  <Link className={styles.link} to={`/forum/topics/${topic.id}`}>{topic.subject}</Link>
                  {topic.status === "locked" ? <span className={styles.meta}> · Locked</span> : null}
                </span>
                <span className={styles.meta}>
                  {topic.authorId !== null
                    ? <PlayerLink playerId={topic.authorId} username={topic.authorName ?? "?"} />
                    : "The management"}
                  {" · "}{topic.postCount} posts{" · last post "}<When iso={topic.lastPostAt} />
                </span>
              </span>
            </li>
          ))}
        </ul>

        {pageCount > 1 ? (
          <div className={styles.actions}>
            <button type="button" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); }}>
              Previous
            </button>
            <span className={styles.meta}>Page {page} of {pageCount}</span>
            <button type="button" disabled={page >= pageCount} onClick={() => { setPage((p) => p + 1); }}>
              Next
            </button>
          </div>
        ) : null}
      </Panel>

      <NewTopic forumId={forumId} />
    </>
  );
}

function NewTopic({ forumId }: { forumId: string }): JSX.Element {
  const create = useCreateTopic(forumId);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  // Mirrors CreateTopicRequestSchema so an obviously bad topic never leaves.
  const valid = subject.length >= 6 && subject.length <= 120 && body.length >= 6 && body.length <= 10_000;

  const submit = (): void => {
    if (!valid) return;
    create.mutate({ subject, body }, {
      onSuccess: () => { setSubject(""); setBody(""); },
    });
  };

  return (
    <Panel title="New topic">
      <div className={styles.stack}>
        <label className={styles.field}>
          <span className={styles.meta}>Subject</span>
          <input
            maxLength={120}
            value={subject}
            onChange={(event) => { setSubject(event.target.value); }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.meta}>Message</span>
          <textarea
            maxLength={10_000}
            value={body}
            onChange={(event) => { setBody(event.target.value); }}
          />
        </label>
        <div className={styles.actions}>
          <button type="button" disabled={!valid || create.isPending} onClick={submit}>
            Post topic
          </button>
        </div>
      </div>
      <ErrorText error={create.error} />
    </Panel>
  );
}

export function Forum(): JSX.Element {
  const { forumId } = useParams();
  if (forumId === undefined) return <ForumList />;
  // Keyed on forumId so navigating between forums remounts the page rather
  // than reusing `page` state from whichever forum was open before.
  return <TopicList key={forumId} forumId={forumId} />;
}
