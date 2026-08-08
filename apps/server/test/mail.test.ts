import type { AddressInfo } from "node:net";
import { ServerFrameSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mailMessages } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let baseUrl: string;
let senderToken: string;
let recipientToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) {
    ({ app, close: closeServer } = await bootTestServer());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}/ws`;
  }
  const sender = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
  senderToken = sender.json().token;
  const recipient = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Sonny", password: "hunter2hunter2" } });
  recipientToken = recipient.json().token;
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

const nextFrame = (socket: WebSocket): Promise<unknown> => {
  const state = frameQueues.get(socket);
  if (!state) throw new Error("socket was not opened via open()");
  if (state.queue.length > 0) return Promise.resolve(state.queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nextFrame: no frame within 4000ms")), 4000);
    state.waiting = (frame) => { clearTimeout(timer); resolve(frame); };
  });
};

describe("POST /api/mail", () => {
  it("sends mail and notifies the recipient live over WS", async () => {
    const ticket = await mintTicket(recipientToken);
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    await nextFrame(socket); // ready
    const incoming = nextFrame(socket);

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
    const other = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Clemenza", password: "hunter2hunter2" } });
    const first = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${senderToken}` },
      payload: { recipientUsername: "Sonny", subject: "Business", body: "We need to talk." },
    });
    const res = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${other.json().token}` },
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
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Clemenza", password: "hunter2hunter2" } });
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
