import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMailThread, useMarkMailRead, useMe, useSendMail } from "../api/queries.js";
import { counterpartName } from "../lib/mail.js";
import { Markdown } from "../components/Markdown.js";
import { MarkdownEditor } from "../components/MarkdownEditor.js";
import { PlayerLink } from "../components/PlayerLink.js";
import { ErrorText, Loading, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

export function MailThread(): JSX.Element {
  const { threadId } = useParams();
  const me = useMe();

  if (threadId === undefined) return <Panel title="Thread">No thread named.</Panel>;
  if (!me.data) return <Loading />;
  return <Thread threadId={threadId} viewerId={me.data.playerId} />;
}

function Thread({ threadId, viewerId }: { threadId: string; viewerId: string }): JSX.Element {
  const thread = useMailThread(threadId);
  const markRead = useMarkMailRead();

  // Opening a thread reads it. The ref is what stops the effect firing twice
  // for the same message: the mutation invalidates the thread, so the refetch
  // re-runs this effect before the server's `readAt` has necessarily landed
  // in the cache, and without the guard that is an endless POST loop.
  const requested = useRef<Set<string>>(new Set());
  const messages = thread.data?.mail;
  // `markRead.mutate` is stable across renders; the result object it comes
  // from is not, which would re-run this effect on every render.
  const markOneRead = markRead.mutate;
  useEffect(() => {
    for (const message of messages ?? []) {
      if (message.readAt !== null) continue;
      if (message.recipientId !== viewerId) continue;   // 404s on someone else's mail
      if (requested.current.has(message.id)) continue;
      requested.current.add(message.id);
      markOneRead({ mailId: message.id, threadId });
    }
  }, [messages, viewerId, threadId, markOneRead]);

  if (thread.isLoading) return <Loading what="the thread" />;

  const list = messages ?? [];
  const subject = list[list.length - 1]?.subject ?? "Thread";
  const other = counterpartName(list, viewerId);

  return (
    <>
      <Panel title={subject}>
        <p className={styles.meta}>
          <Link className={styles.link} to="/mail">← Inbox</Link>
        </p>
        <ErrorText error={thread.error} />

        <div className={styles.stack}>
          {list.map((message) => (
            <article key={message.id}>
              <p className={styles.meta}>
                {message.senderId !== null && message.senderName !== null
                  ? <PlayerLink playerId={message.senderId} username={message.senderName} />
                  : "The management"}
                {" · "}<When iso={message.createdAt} />
              </p>
              <Markdown text={message.body} />
            </article>
          ))}
        </div>
      </Panel>

      {other === null ? (
        <Panel title="Reply">
          <p className={styles.muted}>
            Nobody has written back yet — there is no name to address a reply to.
          </p>
        </Panel>
      ) : (
        <Reply threadId={threadId} to={other} subject={subject} />
      )}
    </>
  );
}

function Reply({ threadId, to, subject }: { threadId: string; to: string; subject: string }): JSX.Element {
  const send = useSendMail();
  const [body, setBody] = useState("");

  const valid = body.length >= 1 && body.length <= 5000;
  const submit = (): void => {
    if (!valid) return;
    // The subject rides along unchanged: the schema requires one on every
    // message, and reusing the thread's keeps the summary stable.
    send.mutate({ recipientUsername: to, subject, body, threadId }, {
      onSuccess: () => { setBody(""); },
    });
  };

  return (
    <Panel title={`Reply to ${to}`}>
      <div className={styles.stack}>
        <div className={styles.field}>
          <span className={styles.meta}>Message</span>
          <MarkdownEditor maxLength={5000} value={body} onChange={setBody} />
        </div>
        <div className={styles.actions}>
          <button type="button" disabled={!valid || send.isPending} onClick={submit}>Send</button>
        </div>
      </div>
      <ErrorText error={send.error} />
    </Panel>
  );
}
