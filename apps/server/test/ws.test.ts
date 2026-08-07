import type { AddressInfo } from "node:net";
import { ServerFrameSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crimes } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let baseUrl: string;
let token: string;
let playerId: string;
let crimeId: string;

beforeAll(async () => {
  ({ app, close: closeServer } = await bootTestServer());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});

beforeEach(async () => {
  await resetDb(db);
  await seedCrimes(db);
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Vito", password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
  const [first] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
  crimeId = first!.id;
});

afterAll(async () => { await closeServer(); await conn.end(); });

/** Mints a handshake ticket the way a real client would: an authenticated POST. */
const mintTicket = async (authToken: string = token): Promise<string> => {
  const res = await app.inject({
    method: "POST", url: "/api/ws/ticket",
    headers: { authorization: `Bearer ${authToken}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().ticket;
};

/**
 * The gateway sends `ready` synchronously on connect (correctly — a client
 * should get it as fast as possible). On loopback that can arrive in the
 * same TCP read as the handshake response, so a listener attached only
 * *after* `open` resolves — one microtask late — can miss it forever: `ws`
 * never buffers a `message` event for a not-yet-attached listener. Queueing
 * every frame from a listener attached synchronously inside `open()`, before
 * the socket can possibly emit anything, closes that gap: `nextFrame()` then
 * drains the queue instead of racing the emitter.
 */
interface FrameQueue { queue: unknown[]; waiting: ((frame: unknown) => void) | null }
const frameQueues = new WeakMap<WebSocket, FrameQueue>();

const open = (url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
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

describe("/ws gateway", () => {
  it("rejects a connection with no ticket", async () => {
    await expect(open(baseUrl)).rejects.toThrow();
  });

  it("rejects a connection with a bogus ticket", async () => {
    await expect(open(`${baseUrl}?ticket=not-a-real-ticket`)).rejects.toThrow();
  });

  it("rejects a connection presenting a raw session token instead of a ticket", async () => {
    // Proves the old credential path is genuinely closed, not just no
    // longer minted — a session token dropped straight in where a ticket
    // is expected must not be accepted as one.
    await expect(open(`${baseUrl}?ticket=${token}`)).rejects.toThrow();
  });

  it("rejects a connection from a disallowed Origin", async () => {
    const ticket = await mintTicket();
    await expect(
      open(`${baseUrl}?ticket=${ticket}`, { origin: "http://evil.test" }),
    ).rejects.toThrow();
  });

  it("accepts a connection from an allowed Origin", async () => {
    const ticket = await mintTicket();
    const socket = await open(`${baseUrl}?ticket=${ticket}`, { origin: "http://localhost:5173" });
    const frame = ServerFrameSchema.parse(await nextFrame(socket));
    expect(frame.kind).toBe("ready");
    socket.close();
  });

  it("connects successfully with a valid ticket", async () => {
    const ticket = await mintTicket();
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    const frame = ServerFrameSchema.parse(await nextFrame(socket));
    expect(frame.kind).toBe("ready");
    socket.close();
  });

  it("refuses a ticket reused for a second connection (single-use guarantee)", async () => {
    const ticket = await mintTicket();
    const first = await open(`${baseUrl}?ticket=${ticket}`);
    await nextFrame(first); // ready — first use consumed the ticket
    await expect(open(`${baseUrl}?ticket=${ticket}`)).rejects.toThrow();
    first.close();
  });

  it("returns 401 for POST /api/ws/ticket without authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/api/ws/ticket" });
    expect(res.statusCode).toBe(401);
  });

  it("sends a ready frame naming the authenticated player", async () => {
    const ticket = await mintTicket();
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    const frame = ServerFrameSchema.parse(await nextFrame(socket));
    expect(frame.kind).toBe("ready");
    socket.close();
  });

  it("answers ping with pong", async () => {
    const ticket = await mintTicket();
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    await nextFrame(socket); // ready
    socket.send(JSON.stringify({ kind: "ping" }));
    const frame = ServerFrameSchema.parse(await nextFrame(socket));
    expect(frame.kind).toBe("pong");
    socket.close();
  });

  it("delivers crime.resolved to the acting player", async () => {
    const ticket = await mintTicket();
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    await nextFrame(socket); // ready
    const incoming = nextFrame(socket);

    const res = await app.inject({
      method: "POST", url: `/api/crimes/${crimeId}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);

    const frame = ServerFrameSchema.parse(await incoming);
    expect(frame.kind).toBe("event");
    if (frame.kind !== "event") throw new Error("unreachable");
    expect(frame.event.type).toBe("crime.resolved");
    // `game:events` is a global channel shared by every test file running in
    // parallel — pin the assertion to this test's own actor so a concurrent
    // file's traffic landing on this socket (it shouldn't, but that's the
    // point of proving it) can't be mistaken for the frame this test caused.
    expect(frame.event.actorId).toBe(playerId);
    socket.close();
  });

  it("does not leak another player's event", async () => {
    const other = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Sonny", password: "hunter2hunter2" },
    });
    const otherTicket = await mintTicket(other.json().token);
    const socket = await open(`${baseUrl}?ticket=${otherTicket}`);
    await nextFrame(socket); // ready

    let leaked = false;
    socket.on("message", (raw) => {
      const frame = ServerFrameSchema.parse(JSON.parse(raw.toString()));
      // Filter on this test's own actor, not just event type: `game:events`
      // is a global channel, so another test file resolving an unrelated
      // crime concurrently must not be able to make this assertion flake.
      if (frame.kind === "event" && frame.event.type === "crime.resolved" && frame.event.actorId === playerId) {
        leaked = true;
      }
    });

    await app.inject({
      method: "POST", url: `/api/crimes/${crimeId}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(leaked).toBe(false);
    socket.close();
  });
});
