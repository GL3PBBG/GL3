import { useState } from "react";
import { Link } from "react-router-dom";
import { useMail, useSendMail } from "../api/queries.js";
import { groupThreads } from "@gl3/client";
import { ErrorText, Loading, Panel, When } from "../components/ui.js";
import { MarkdownEditor } from "../components/MarkdownEditor.js";
import { PlayerLink } from "../components/PlayerLink.js";
import styles from "./pages.module.css";

export function Mail(): JSX.Element {
  const mail = useMail();
  const threads = groupThreads(mail.data?.mail ?? []);

  return (
    <>
      <Panel title="Inbox">
        {mail.isLoading ? <Loading what="your mail" /> : null}
        <ErrorText error={mail.error} />

        {threads.length === 0 && !mail.isLoading
          ? <p className={styles.muted}>No mail.</p>
          : null}

        <ul className={styles.rows}>
          {threads.map((thread) => (
            <li
              key={thread.threadId}
              className={thread.unread > 0 ? `${styles.row} ${styles.unread}` : styles.row}
            >
              <span className={styles.rowStack}>
                <Link className={styles.link} to={`/mail/${thread.threadId}`}>{thread.subject}</Link>
                <span className={styles.meta}>
                  {thread.withId !== null && thread.withName !== null
                    ? <PlayerLink playerId={thread.withId} username={thread.withName} />
                    : "The management"}
                  {" · "}<When iso={thread.lastAt} />
                </span>
              </span>
              {thread.unread > 0
                ? <span className={`${styles.chip} ${styles.chipOn}`}>{thread.unread} unread</span>
                : null}
            </li>
          ))}
        </ul>
      </Panel>

      <Compose />
    </>
  );
}

/**
 * Starts a new thread. Replies live on the thread page instead, because that
 * is the only place the other party's *username* can be read — MailDto names
 * the sender but not the recipient.
 */
function Compose(): JSX.Element {
  const send = useSendMail();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  // Mirrors SendMailRequestSchema so an obviously bad message never leaves.
  const valid = to.length >= 3 && to.length <= 30
    && subject.length >= 1 && subject.length <= 200
    && body.length >= 1 && body.length <= 5000;

  const submit = (): void => {
    if (!valid) return;
    send.mutate({ recipientUsername: to, subject, body }, {
      onSuccess: () => { setSubject(""); setBody(""); },
    });
  };

  return (
    <Panel title="New message">
      <div className={styles.stack}>
        <label className={styles.field}>
          <span className={styles.meta}>To</span>
          <input
            maxLength={30}
            value={to}
            onChange={(event) => { setTo(event.target.value.trim()); }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.meta}>Subject</span>
          <input
            maxLength={200}
            value={subject}
            onChange={(event) => { setSubject(event.target.value); }}
          />
        </label>
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
