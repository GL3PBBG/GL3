import type { AddressInfo } from "node:net";
import { ServerFrameSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import WebSocket from "ws";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mailMessages } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let baseUrl: string;
let senderToken: string;
let recipientToken: string;
let recipientId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) {
    ({ app, close: closeServer, redis } = await bootTestServer());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}/ws`;
  }
  const sender = await registerVerifiedPlayer({ app, redis }, { username: "Vito" });
  senderToken = sender.token;
  const recipient = await registerVerifiedPlayer({ app, redis }, { username: "Sonny" });
  recipientToken = recipient.token;
  recipientId = recipient.playerId;
});

afterAll(async () => { await closeServer(); await conn.end(); });

/**
 * Mints the handshake ticket the way a real client would: an authenticated
 * POST. The `/ws` upgrade only accepts a short-lived ticket in its query
 * string, never a raw session token (see gateway.ts and ws.test.ts's
 * "rejects a connection presenting a raw session token instead of a
 * ticket") — the brief's sample test connected with `?token=`, which the
 * gateway rejects outright. Every WS assertion here mints a ticket first,
 * matching gang-invites.test.ts.
 */
const mintTicket = async (authToken: string): Promise<string> => {
  const res = await app.inject({ method: "POST", url: "/api/ws/ticket", headers: { authorization: `Bearer ${authToken}` } });
  expect(res.statusCode).toBe(201);
  return res.json().ticket;
};

/**
 * Same queueing `open`/`nextFrame` pair as gang-invites.test.ts and
 * ws.test.ts: the gateway sends `ready` synchronously on connect, which on
 * loopback can arrive before a listener attached only after `open()`
 * resolves — `ws` never buffers a `message` event for a not-yet-attached
 * listener. Queueing from a listener attached synchronously inside `open()`
 * closes that gap.
 */
interface FrameQueue { queue: unknown[]; waiting: ((frame: unknown) => void) | null }
const frameQueues = new WeakMap<WebSocket, FrameQueue>();

const open = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const state: FrameQueue = { queue: [], waiting: null };
    frameQueues.set(socket, state);
    socket.on("message", (raw) => {
      const frame: unknown = JSON.parse(raw.toString());
      if (state.waiting) {
        const deliver = state.waiting;
        state.waiting = null;
        deliver(frame);
      } else {
        state.queue.push(frame);
      }
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

/**
 * Resolves with the next frame matching `predicate` (default: any frame),
 * silently discarding anything else along the way.
 *
 * `game:events` is a single Redis channel shared by every test file running
 * concurrently, and the gateway broadcasts every `global`-audience event
 * (e.g. `news.posted`) to *every* connected socket regardless of who it's
 * "for" (gateway.ts's `route`, "global" case) — so an unfiltered `nextFrame`
 * can consume a stranger's frame instead of the one this test is actually
 * waiting for. This is the WS-socket-level equivalent of CLAUDE.md rule 4
 * ("tests asserting on `game:events` must filter by their own actorId") —
 * see `test/helpers/events.ts`'s `awaitOwnEvent`, which does the same thing
 * one layer down, directly on the Redis subscription. Bounded by the same
 * 4000ms so a genuinely missing frame still fails loudly instead of hanging.
 */
const nextFrame = (socket: WebSocket, predicate: (frame: unknown) => boolean = () => true): Promise<unknown> => {
  const state = frameQueues.get(socket);
  if (!state) throw new Error("socket was not opened via open()");
  while (state.queue.length > 0) {
    const frame = state.queue.shift();
    if (predicate(frame)) return Promise.resolve(frame);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nextFrame: no matching frame within 4000ms")), 4000);
    const waitForMatch = (frame: unknown): void => {
      if (predicate(frame)) { clearTimeout(timer); resolve(frame); return; }
      state.waiting = waitForMatch;
    };
    state.waiting = waitForMatch;
  });
};

// mail.received's actor is the *sender* (schema: "actor = the sender, or
// the recipient for system mail"), so filtering on actorId the way
// gang-invites.test.ts / m3-acceptance.test.ts do for notification.created
// would not identify this test's own wait — recipientId is the field that does.
/** Matches a `mail.received` server frame addressed to `recipientId` — see nextFrame's predicate. */
const isMailFor = (recipientId: string) => (frame: unknown): boolean => {
  const parsed = ServerFrameSchema.safeParse(frame);
  return parsed.success && parsed.data.kind === "event"
    && parsed.data.event.type === "mail.received" && parsed.data.event.recipientId === recipientId;
};

describe("POST /api/mail", () => {
  it("sends mail and notifies the recipient live over WS", async () => {
    const ticket = await mintTicket(recipientToken);
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    await nextFrame(socket); // ready
    const incoming = nextFrame(socket, isMailFor(recipientId));

    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: "We need to talk." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().threadId).toBeDefined();

    const frame = ServerFrameSchema.parse(await incoming);
    expect(frame.kind).toBe("event");
    if (frame.kind !== "event") throw new Error("unreachable");
    expect(frame.event.type).toBe("mail.received");
    socket.close();
  });

  it("404s an unknown recipient", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "NoSuchPlayer", subject: "Hi", body: "Hi" },
    });
    expect(res.statusCode).toBe(404);
  });

  // Postgres `text` columns (subject, body) and text parameters
  // (recipientUsername, in an `eq(players.username, ...)` lookup) all
  // reject an embedded NUL byte outright (SQLSTATE 22021); z.string() alone
  // doesn't, so each of these 500ed before noNulByte guarded them.
  it("400s a NUL byte in subject instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: `Business${String.fromCharCode(0)}`, body: "We need to talk." },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a NUL byte in body instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: `We need${String.fromCharCode(0)}to talk.` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a NUL byte in recipientUsername instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: `Sonny${String.fromCharCode(0)}`, subject: "Business", body: "We need to talk." },
    });
    expect(res.statusCode).toBe(400);
  });

  it("continues a thread when threadId is supplied", async () => {
    const first = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: "We need to talk." },
    });
    const reply = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${recipientToken}` },
      payload: { recipientUsername: "Vito", subject: "Re: Business", body: "Ok.", threadId: first.json().threadId },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().threadId).toBe(first.json().threadId);
  });

  it("403s replying with a threadId that isn't yours", async () => {
    const other = await registerVerifiedPlayer({ app, redis }, { username: "Clemenza" });
    const first = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: "We need to talk." },
    });
    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${other.token}` },
      payload: { recipientUsername: "Sonny", subject: "Snoop", body: "...", threadId: first.json().threadId },
    });
    expect(res.statusCode).toBe(403);
  });

  // Regression guard for a defect found in the brief's sample route: it
  // verified the *sender* was a thread participant when replying, but never
  // verified the *recipient* was too. That let a genuine participant splice
  // a completely unrelated third party into someone else's private thread
  // (e.g. Vito continuing his thread with Sonny, but addressing the reply to
  // Clemenza) merely by reusing the threadId — corrupting what a "thread"
  // means without ever tripping the sender-side check above.
  it("403s replying in a real thread to a recipient who isn't part of it", async () => {
    // Never authenticates as Clemenza below, just needs the username to resolve as a recipient.
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Clemenza", email: "clemenza@example.test", password: "hunter2hunter2" } });
    const first = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: "We need to talk." },
    });
    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Clemenza", subject: "Business", body: "Wrong person.", threadId: first.json().threadId },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/mail and thread/:threadId", () => {
  it("lists the inbox and the full thread, and marks read", async () => {
    const sent = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: "We need to talk." },
    });
    const threadId = sent.json().threadId;

    const inbox = await app.inject({ method: "GET", url: "/api/mail", headers: { authorization: `Bearer ${recipientToken}` } });
    expect(inbox.json().mail).toHaveLength(1);
    expect(inbox.json().mail[0].readAt).toBeNull();

    const thread = await app.inject({
      method: "GET", url: `/api/mail/thread/${threadId}`, headers: { authorization: `Bearer ${recipientToken}` },
    });
    expect(thread.json().mail).toHaveLength(1);
    // Sender name resolution must not be dropped in the thread view — the
    // brief's sample hardcoded `null` here even though it correctly resolves
    // names for the inbox view above.
    expect(thread.json().mail[0].senderName).toBe("Vito");

    const mailId = inbox.json().mail[0].id;
    const read = await app.inject({
      method: "POST", url: `/api/mail/${mailId}/read`, headers: { authorization: `Bearer ${recipientToken}` },
    });
    expect(read.statusCode).toBe(204);
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, mailId));
    expect(row?.readAt).not.toBeNull();
  });

  it("404s marking mail read that belongs to someone else", async () => {
    const sent = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: "We need to talk." },
    });
    const mailId = sent.json().id;
    const res = await app.inject({
      method: "POST", url: `/api/mail/${mailId}/read`, headers: { authorization: `Bearer ${senderToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
