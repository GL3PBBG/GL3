import type { MailDto } from "@gl3/shared";

/**
 * `GET /api/mail` returns individual messages the viewer *received*, newest
 * first — not threads. The inbox screen shows one row per conversation, so
 * the folding happens here, where it can be tested without a DOM.
 *
 * Because the inbox is received-only, the other party is always the sender;
 * no viewer id is needed to work out who a thread is "with". (The thread
 * endpoint is the one that also returns the viewer's own replies.)
 */
export interface ThreadSummary {
  threadId: string;
  /** The newest message's subject — a reply may have retitled the thread. */
  subject: string;
  /** Sender of the newest message; null when it came from the system. */
  withName: string | null;
  lastAt: string;
  unread: number;
}

export function groupThreads(mail: readonly MailDto[]): ThreadSummary[] {
  const byThread = new Map<string, ThreadSummary>();

  for (const message of mail) {
    const existing = byThread.get(message.threadId);
    if (!existing) {
      byThread.set(message.threadId, {
        threadId: message.threadId,
        subject: message.subject,
        withName: message.senderName,
        lastAt: message.createdAt,
        unread: message.readAt === null ? 1 : 0,
      });
      continue;
    }
    if (message.readAt === null) existing.unread += 1;
    // Don't assume the server's ordering held: whichever message is newest
    // supplies the summary's subject and name.
    if (message.createdAt > existing.lastAt) {
      existing.subject = message.subject;
      existing.withName = message.senderName;
      existing.lastAt = message.createdAt;
    }
  }

  // Timestamps are ISO-8601 UTC strings from TimestampSchema, so lexical
  // order is chronological order.
  return [...byThread.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/**
 * Who to address a reply to, from a *thread* (which, unlike the inbox, also
 * contains the viewer's own messages).
 *
 * `MailDto` names the sender but not the recipient, so the only way to learn
 * the other party's username is from a message they sent. That leaves one
 * case with no answer: a thread the viewer started and nobody has replied to.
 * Returning null there is the honest result — the reply box disables rather
 * than guessing a recipient the server would reject.
 *
 * System mail has `senderId: null`; it is skipped, because there is nobody to
 * reply to.
 */
export function counterpartName(
  messages: readonly MailDto[], viewerId: string,
): string | null {
  for (const message of messages) {
    if (message.senderId !== null && message.senderId !== viewerId) return message.senderName;
  }
  return null;
}

/** Drives the nav badge; counts messages, not threads. */
export function unreadCount(mail: readonly MailDto[]): number {
  return mail.reduce((total, message) => (message.readAt === null ? total + 1 : total), 0);
}
