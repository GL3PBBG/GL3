import { describe, expect, it } from "vitest";
import type { MailDto } from "@gl3/shared";
import { counterpartName, groupThreads, unreadCount } from "../src/lib/mail.js";

function message(overrides: Partial<MailDto> & { id: string; threadId: string; createdAt: string }): MailDto {
  return {
    senderId: "sender",
    senderName: "Vito",
    recipientId: "me",
    subject: "Business",
    body: "…",
    readAt: null,
    ...overrides,
  };
}

describe("groupThreads", () => {
  it("folds one thread's messages into a single summary", () => {
    const threads = groupThreads([
      message({ id: "1", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z", readAt: "2026-01-01T00:01:00.000Z" }),
      message({ id: "2", threadId: "t1", createdAt: "2026-01-02T00:00:00.000Z" }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      threadId: "t1",
      subject: "Business",
      withName: "Vito",
      withId: "sender",
      lastAt: "2026-01-02T00:00:00.000Z",
      unread: 1,
    });
  });

  it("returns nothing for an empty inbox", () => {
    expect(groupThreads([])).toEqual([]);
  });

  // The inbox arrives newest-first today, but a summary that only holds
  // whichever message it saw first would silently depend on that.
  it("takes the subject and sender from the newest message, whatever the input order", () => {
    const oldest = message({ id: "1", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z", subject: "First", senderId: "vito", senderName: "Vito" });
    const newest = message({ id: "2", threadId: "t1", createdAt: "2026-03-01T00:00:00.000Z", subject: "Re: First", senderId: "sonny", senderName: "Sonny" });

    for (const order of [[oldest, newest], [newest, oldest]]) {
      const [summary] = groupThreads(order);
      expect(summary?.subject).toBe("Re: First");
      expect(summary?.withName).toBe("Sonny");
      expect(summary?.withId).toBe("sonny");
      expect(summary?.lastAt).toBe("2026-03-01T00:00:00.000Z");
    }
  });

  it("orders threads newest first", () => {
    const threads = groupThreads([
      message({ id: "1", threadId: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      message({ id: "2", threadId: "new", createdAt: "2026-06-01T00:00:00.000Z" }),
      message({ id: "3", threadId: "mid", createdAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(threads.map((t) => t.threadId)).toEqual(["new", "mid", "old"]);
  });

  it("counts only the unread messages in each thread", () => {
    const threads = groupThreads([
      message({ id: "1", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z" }),
      message({ id: "2", threadId: "t1", createdAt: "2026-01-02T00:00:00.000Z" }),
      message({ id: "3", threadId: "t2", createdAt: "2026-01-03T00:00:00.000Z", readAt: "2026-01-03T00:05:00.000Z" }),
    ]);
    expect(threads.map((t) => [t.threadId, t.unread])).toEqual([["t2", 0], ["t1", 2]]);
  });

  // A system message (jail release, gang notice) has no sender row at all.
  it("keeps a null sender rather than inventing a name", () => {
    const [summary] = groupThreads([
      message({ id: "1", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z", senderId: null, senderName: null }),
    ]);
    expect(summary?.withName).toBeNull();
    expect(summary?.withId).toBeNull();
  });

  it("does not mutate the messages it was given", () => {
    const original = message({ id: "1", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z" });
    const copy = { ...original };
    groupThreads([original]);
    expect(original).toEqual(copy);
  });
});

describe("counterpartName", () => {
  const mine = message({
    id: "1", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z",
    senderId: "me", senderName: "Michael",
  });

  it("names the other party, skipping the viewer's own messages", () => {
    expect(counterpartName([mine, message({ id: "2", threadId: "t1", createdAt: "2026-01-02T00:00:00.000Z" })], "me"))
      .toBe("Vito");
  });

  // Reachable: a thread the viewer started that nobody has answered. MailDto
  // carries no recipient name, so there is genuinely nothing to address.
  it("returns null when only the viewer has written", () => {
    expect(counterpartName([mine], "me")).toBeNull();
  });

  it("ignores system mail, which has nobody to reply to", () => {
    const system = message({
      id: "2", threadId: "t1", createdAt: "2026-01-02T00:00:00.000Z",
      senderId: null, senderName: null,
    });
    expect(counterpartName([mine, system], "me")).toBeNull();
  });
});

describe("unreadCount", () => {
  it("counts messages, not threads", () => {
    expect(unreadCount([
      message({ id: "1", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z" }),
      message({ id: "2", threadId: "t1", createdAt: "2026-01-02T00:00:00.000Z" }),
      message({ id: "3", threadId: "t2", createdAt: "2026-01-03T00:00:00.000Z", readAt: "2026-01-03T00:05:00.000Z" }),
    ])).toBe(2);
  });

  it("is zero for an empty inbox", () => {
    expect(unreadCount([])).toBe(0);
  });
});
