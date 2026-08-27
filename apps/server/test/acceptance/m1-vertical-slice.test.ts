import type { AddressInfo } from "node:net";
import { ServerFrameSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crimeLog, crimes, playerStats, transactions } from "../../src/db/schema/index.js";
import { seedCrimes } from "../../src/db/seed.js";
import { resetDb, testDb } from "../helpers/db.js";
import { registerVerifiedPlayer } from "../helpers/register.js";
import { bootTestServer } from "../helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let wsBase: string;

beforeAll(async () => {
  ({ app, close: closeServer, redis } = await bootTestServer());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { await closeServer(); await conn.end(); });
beforeEach(async () => { await resetDb(db); await seedCrimes(db, "v2"); });

async function register(username: string): Promise<{ token: string; playerId: string }> {
  return registerVerifiedPlayer({ app, redis }, { username });
}

/** Mints a handshake ticket the way a real client would: an authenticated POST.
 * The ticket is single-use, so every connection — including any retry —
 * needs its own freshly-minted one (SPEC §2.2). */
async function mintTicket(token: string): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/ws/ticket",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().ticket;
}

/**
 * The gateway sends `ready` synchronously on connect, which on loopback can
 * arrive in the same TCP read as the handshake response — a `message`
 * listener attached only after `open` resolves can miss it forever. Queueing
 * every frame from a listener attached synchronously inside `open()`, before
 * the socket can possibly emit anything, closes that gap (mirrors
 * apps/server/test/ws.test.ts).
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

async function connect(token: string): Promise<WebSocket> {
  const ticket = await mintTicket(token);
  const socket = await open(`${wsBase}?ticket=${ticket}`);
  const ready = ServerFrameSchema.parse(await nextFrame(socket));
  expect(ready.kind).toBe("ready");
  return socket;
}

/**
 * Waits for this player's own `crime.resolved`, bounded so a missing frame
 * fails rather than hangs. Filters on `actorId`, not just event type:
 * `game:events` is a global channel shared by every test file running in
 * parallel, so another file's traffic must not be able to satisfy or break
 * this assertion.
 */
function awaitOwnCrimeResolved(socket: WebSocket, actorId: string, timeoutMs = 5000): Promise<GameEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for crime.resolved")), timeoutMs);
    const state = frameQueues.get(socket);
    if (!state) { reject(new Error("socket was not opened via open()")); return; }

    const tryConsumeQueued = (): boolean => {
      const idx = state.queue.findIndex((raw) => {
        const frame = ServerFrameSchema.parse(raw);
        return frame.kind === "event" && frame.event.type === "crime.resolved" && frame.event.actorId === actorId;
      });
      if (idx === -1) return false;
      const [raw] = state.queue.splice(idx, 1);
      const frame = ServerFrameSchema.parse(raw);
      if (frame.kind !== "event") throw new Error("unreachable");
      clearTimeout(timer);
      resolve(frame.event);
      return true;
    };

    if (tryConsumeQueued()) return;

    socket.on("message", (raw) => {
      const frame = ServerFrameSchema.parse(JSON.parse(raw.toString()));
      if (frame.kind === "event" && frame.event.type === "crime.resolved" && frame.event.actorId === actorId) {
        clearTimeout(timer);
        resolve(frame.event);
      }
    });
  });
}

describe("M1 acceptance — commit-crime vertical slice", () => {
  it("accepts exactly one of two concurrent commits and delivers crime.resolved over WS", async () => {
    const { token, playerId } = await register("Vito");
    const socket = await connect(token);
    const resolved = awaitOwnCrimeResolved(socket, playerId);

    const [pickpocket] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    const url = `/api/crimes/${pickpocket!.id}/commit`;
    const headers = { authorization: `Bearer ${token}` };

    // HTTP → Redis cooldown: two simultaneous requests, one winner.
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url, headers }),
      app.inject({ method: "POST", url, headers }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 429]);

    // BullMQ → Postgres tx → pub/sub → WS.
    const event = await resolved;
    if (event.type !== "crime.resolved") throw new Error("unreachable");
    expect(event.actorId).toBe(playerId);
    expect(event.actorName).toBe("Vito");
    expect(event.crimeName).toBe("Pickpocket");

    // Exactly one job ran, so exactly one crime_log row exists.
    expect(await db.select().from(crimeLog)).toHaveLength(1);

    // Economy invariant: the ledger explains the balance, with no row on a failure.
    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    const ledger = await db.select().from(transactions);
    if (event.success) {
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.amount).toBe(BigInt(event.payout));
      expect(stats?.cash).toBe(BigInt(event.payout));
    } else {
      expect(ledger).toHaveLength(0);
      expect(stats?.cash).toBe(0n);
    }

    socket.close();
  });

  it("keeps two different players independent — each gets only their own outcome", async () => {
    const vito = await register("Vito");
    const sonny = await register("Sonny");
    const [vitoSocket, sonnySocket] = await Promise.all([connect(vito.token), connect(sonny.token)]);

    const vitoEvent = awaitOwnCrimeResolved(vitoSocket, vito.playerId);
    const sonnyEvent = awaitOwnCrimeResolved(sonnySocket, sonny.playerId);

    const [pickpocket] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    const url = `/api/crimes/${pickpocket!.id}/commit`;

    // A cooldown is per player, so both are accepted.
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url, headers: { authorization: `Bearer ${vito.token}` } }),
      app.inject({ method: "POST", url, headers: { authorization: `Bearer ${sonny.token}` } }),
    ]);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);

    const [forVito, forSonny] = await Promise.all([vitoEvent, sonnyEvent]);
    if (forVito.type !== "crime.resolved" || forSonny.type !== "crime.resolved") throw new Error("unreachable");
    expect(forVito.actorId).toBe(vito.playerId);
    expect(forSonny.actorId).toBe(sonny.playerId);

    expect(await db.select().from(crimeLog)).toHaveLength(2);

    vitoSocket.close();
    sonnySocket.close();
  });
});
