import { useState, type Dispatch, type SetStateAction } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client.js";
import {
  useCreatePost, useDeletePost, useDeleteTopic, useForumTopic, useLockTopic, useMe, useSetTopicType,
} from "../api/queries.js";
import { useCountdowns } from "../hooks/useCountdowns.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { CooldownButton, ErrorText, Loading, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

/**
 * V2 parity: one 15s Redis key per *player* between posts (see
 * `packages/plugins/forum/src/index.ts` `POST_COOLDOWN_SECONDS`), not one per
 * topic — Crimes.tsx's `COOLDOWN_ID` note is the same shape. One id covers
 * every reply the caller might post, on this topic or any other.
 */
const REPLY_COOLDOWN_ID = "forum.post";
const REPLY_COOLDOWN_SECONDS = 15;

export function ForumTopic(): JSX.Element {
  const { topicId } = useParams();
  const me = useMe();

  if (topicId === undefined) return <Panel title="Topic">No topic named.</Panel>;
  if (!me.data) return <Loading />;
  // Keyed on topicId, same reasoning as Forum.tsx's TopicList: without it,
  // navigating from one topic straight to another reuses this instance and
  // its `page`/`body` state instead of starting fresh.
  return <Topic key={topicId} topicId={topicId} grants={me.data.grants} />;
}

function Topic({ topicId, grants }: { topicId: string; grants: readonly string[] }): JSX.Element {
  const [page, setPage] = useState(1);
  const topic = useForumTopic(topicId, page);
  const [body, setBody] = useState("");

  // Same grant `hasPermission` checks server-side (`MODULE_KEY = "forum"`,
  // packages/plugin-sdk/src/authz.ts) — restated here because a plugin-only
  // package is off-limits to apps/web (see queries.ts's own restatement note).
  const isMod = grants.includes("forum") || grants.includes("*");

  if (topic.isLoading) return <Loading what="the topic" />;

  const data = topic.data;
  const posts = data?.posts ?? [];
  const pageCount = data?.pageCount ?? 1;
  const locked = data?.topic.status === "locked";

  return (
    <>
      <Panel title={data?.topic.subject ?? "Topic"}>
        <p className={styles.meta}>
          <Link className={styles.link} to="/forum">← Forums</Link>
        </p>
        <ErrorText error={topic.error} />

        {data && isMod ? (
          <ModControls topicId={topicId} status={data.topic.status} type={data.topic.type} />
        ) : null}

        {locked ? <p className={styles.meta}>This topic is locked.</p> : null}

        <div className={styles.stack}>
          {posts.map((post) => (
            <article key={post.id}>
              <p className={styles.meta}>
                {post.authorId !== null
                  ? <PlayerLink playerId={post.authorId} username={post.authorName ?? "?"} />
                  : "The management"}
                {" · "}<When iso={post.createdAt} />
              </p>
              <p className={styles.prose}>{post.body}</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() => {
                    const author = post.authorName ?? "The management";
                    // "> author wrote:\n> first 200 chars…" — prepended, so a
                    // draft already in the box survives a Quote click.
                    setBody((current) => `> ${author} wrote:\n> ${post.body.slice(0, 200)}\n\n${current}`);
                  }}
                >
                  Quote
                </button>
                {isMod ? <DeletePostButton topicId={topicId} postId={post.id} /> : null}
              </div>
            </article>
          ))}
        </div>

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

      {locked ? (
        <Panel title="Reply">
          <p className={styles.muted}>This topic is locked — no new replies.</p>
        </Panel>
      ) : (
        <Reply topicId={topicId} body={body} setBody={setBody} />
      )}
    </>
  );
}

function Reply({
  topicId, body, setBody,
}: {
  topicId: string;
  body: string;
  setBody: Dispatch<SetStateAction<string>>;
}): JSX.Element {
  const create = useCreatePost(topicId);
  const { remaining, start } = useCountdowns();
  const cooldown = remaining[REPLY_COOLDOWN_ID] ?? 0;

  // Mirrors CreatePostRequestSchema so an obviously bad reply never leaves.
  const valid = body.length >= 6 && body.length <= 10_000;

  const submit = (): void => {
    if (!valid) return;
    // Lock optimistically so the button reacts on click rather than when the
    // response lands — Crimes.tsx's `start`-then-correct idiom.
    start(REPLY_COOLDOWN_ID, REPLY_COOLDOWN_SECONDS);
    create.mutate({ body }, {
      onSuccess: () => { setBody(""); },
      onError: (error) => {
        if (!(error instanceof ApiError)) return;
        // The optimistic guess was wrong (e.g. an earlier reply elsewhere on
        // the forum already claimed part of the window) — take the server's.
        if (error.retryAfter !== undefined) start(REPLY_COOLDOWN_ID, error.retryAfter);
      },
    });
  };

  return (
    <Panel title="Reply">
      <div className={styles.stack}>
        <label className={styles.field}>
          <span className={styles.meta}>Message</span>
          <textarea
            maxLength={10_000}
            value={body}
            onChange={(event) => { setBody(event.target.value); }}
          />
        </label>
        <div className={styles.actions}>
          <CooldownButton
            label="Reply"
            seconds={cooldown}
            disabled={!valid || create.isPending}
            onClick={submit}
          />
        </div>
      </div>
      <ErrorText error={create.error} />
    </Panel>
  );
}

function ModControls({
  topicId, status, type,
}: {
  topicId: string;
  status: "open" | "locked";
  type: "normal" | "sticky";
}): JSX.Element {
  const lock = useLockTopic(topicId);
  const setType = useSetTopicType(topicId);
  const deleteTopic = useDeleteTopic();
  const navigate = useNavigate();
  // Deleting the whole topic is irreversible — two-step in the row, not
  // `window.confirm` (Properties.tsx's OwnedControls documents why: nothing
  // else in this app opens a native dialog).
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className={styles.actions}>
      <button
        type="button"
        disabled={lock.isPending}
        onClick={() => { lock.mutate(status !== "locked"); }}
      >
        {status === "locked" ? "Unlock" : "Lock"}
      </button>
      <button
        type="button"
        disabled={setType.isPending}
        onClick={() => { setType.mutate(type === "sticky" ? "normal" : "sticky"); }}
      >
        {type === "sticky" ? "Unstick" : "Make sticky"}
      </button>
      {confirmingDelete ? (
        <>
          <span className={styles.meta} role="alert">Delete this topic and every reply?</span>
          <button
            type="button"
            disabled={deleteTopic.isPending}
            onClick={() => {
              deleteTopic.mutate(topicId, { onSuccess: () => { navigate("/forum"); } });
            }}
          >
            Confirm delete
          </button>
          <button type="button" onClick={() => { setConfirmingDelete(false); }}>Cancel</button>
        </>
      ) : (
        <button type="button" onClick={() => { setConfirmingDelete(true); }}>Delete topic</button>
      )}
      <ErrorText error={lock.error ?? setType.error ?? deleteTopic.error} />
    </div>
  );
}

function DeletePostButton({ topicId, postId }: { topicId: string; postId: string }): JSX.Element {
  const deletePost = useDeletePost(topicId);
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <>
        <button type="button" disabled={deletePost.isPending} onClick={() => { deletePost.mutate(postId); }}>
          Confirm delete
        </button>
        <button type="button" onClick={() => { setConfirming(false); }}>Cancel</button>
      </>
    );
  }
  return <button type="button" onClick={() => { setConfirming(true); }}>Delete</button>;
}
