import type { AddressInfo } from "node:net";
import { ServerFrameSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { gangInvites, playerStats } from "../src/db/schema/index.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let baseUrl: string;
let bossToken: string;
let bossId: string;
let gangId: string;
let inviteeToken: string;
let inviteeId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) {
    ({ app, close: closeServer } = await bootTestServer());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}/ws`;
  }

  const boss = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
  ({ token: bossToken, playerId: bossId } = boss.json());
  const invitee = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Sonny", password: "hunter2hunter2" } });
  ({ token: inviteeToken, playerId: inviteeId } = invitee.json());

  const gang = await app.inject({
    method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${bossToken}` },
    payload: { name: "The Corleones" },
  });
  gangId = gang.json().id;
});

afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); });

/**
 * Mints the handshake ticket the way a real client would: an authenticated
 * POST. The `/ws` upgrade only accepts a short-lived ticket in its query
 * string, never a raw session token (see gateway.ts and ws.test.ts's
 * "rejects a connection presenting a raw session token instead of a
 * ticket") — the brief's sample test connected with `?token=`, which the
 * gateway rejects outright, so every WS assertion here mints a ticket first.
 */
const mintTicket = async (authToken: string): Promise<string> => {
  const res = await app.inject({ method: "POST", url: "/api/ws/ticket", headers: { authorization: `Bearer ${authToken}` } });
  expect(res.statusCode).toBe(201);
  return res.json().ticket;
};

/**
 * Same queueing `open`/`nextFrame` pair as ws.test.ts: the gateway sends
 * `ready` synchronously on connect, which on loopback can arrive before a
 * listener attached only after `open()` resolves — `ws` never buffers a
 * `message` event for a not-yet-attached listener. Queueing from a listener
 * attached synchronously inside `open()` closes that gap.
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

describe("POST /api/gangs/:gangId/invites", () => {
  it("invites a player and notifies them live over WS", async () => {
    const ticket = await mintTicket(inviteeToken);
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    await nextFrame(socket); // ready
    const incoming = nextFrame(socket);

    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    expect(res.statusCode).toBe(201);

    const frame = ServerFrameSchema.parse(await incoming);
    expect(frame.kind).toBe("event");
    if (frame.kind !== "event") throw new Error("unreachable");
    expect(frame.event.type).toBe("notification.created");
    socket.close();
  });

  it("403s a member with no invite permission", async () => {
    const other = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Clemenza", password: "hunter2hunter2" } });
    // Clemenza isn't a member of the gang at all yet.
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${other.json().token}` },
      payload: { username: "Sonny" },
    });
    expect(res.statusCode).toBe(403);
  });

  // The invite route was the last gangId route calling hasGangPermission
  // without an existence check first. hasGangPermission returns false for a
  // missing gang, so a nonexistent gangId came back 403 while kick, both
  // permission routes and both bank routes all answer 404 for the same
  // input. GET /api/gangs/:gangId already makes gang existence visible to
  // any authenticated player, so answering 404 here leaks nothing new.
  it("404s a nonexistent gang, not 403 — existence is checked before permission", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs/00000000-0000-0000-0000-000000000000/invites",
      headers: { authorization: `Bearer ${bossToken}` }, payload: { username: "Sonny" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s an unknown username", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "NoSuchPlayer" },
    });
    expect(res.statusCode).toBe(404);
  });

  // `username` here isn't persisted, but reaches Postgres as an
  // `eq(players.username, ...)` lookup parameter — Postgres rejects an
  // embedded NUL in any text parameter, not just one being written
  // (SQLSTATE 22021), so this 500ed before noNulByte guarded it.
  it("400s a NUL byte in username instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: `Sonny${String.fromCharCode(0)}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409s inviting a target who is already in a gang", async () => {
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${inviteeToken}` },
      payload: { name: "Sonny's Crew" },
    });
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    expect(res.statusCode).toBe(409);
  });

  // Regression test for a review finding: the event's actorId was the
  // inviter's, not the invitee's, breaking events.ts's documented contract
  // ("actor = the notified player") and awaitOwnEvent(subscriber, actorId) —
  // the mandated NOTES.md rule-4 pattern for the shared game:events
  // channel — which any caller filtering on the invitee's id would then
  // never see. The WS test above only proves *a* frame arrives on the
  // invitee's own socket; it doesn't inspect actorId, so it passed both
  // before and after this bug existed.
  it("publishes notification.created with the invitee, not the inviter, as actor", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = awaitOwnEvent(subscriber, inviteeId);

    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    expect(res.statusCode).toBe(201);

    const event = await received;
    expect(event.type).toBe("notification.created");
    expect(event.actorId).toBe(inviteeId);
  });
});

describe("POST /api/gangs/invites/:inviteId/accept", () => {
  it("joins the gang, clears the invite, and publishes gang.memberJoined to the gang", async () => {
    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, inviteeId));

    const bossTicket = await mintTicket(bossToken);
    const bossSocket = await open(`${baseUrl}?ticket=${bossTicket}`);
    await nextFrame(bossSocket); // ready
    const incoming = nextFrame(bossSocket);

    const res = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${inviteeToken}` },
    });
    expect(res.statusCode).toBe(200);

    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, inviteeId));
    expect(stats?.gangId).toBe(gangId);
    expect(await db.select().from(gangInvites)).toHaveLength(0);

    const frame = ServerFrameSchema.parse(await incoming);
    expect(frame.kind).toBe("event");
    if (frame.kind !== "event") throw new Error("unreachable");
    expect(frame.event.type).toBe("gang.memberJoined");
    bossSocket.close();
  });

  it("409s accepting while already in a gang", async () => {
    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, inviteeId));
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${inviteeToken}` },
      payload: { name: "Sonny's Crew" },
    });

    const res = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${inviteeToken}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s accepting an invite that belongs to a different player", async () => {
    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, inviteeId));
    const bystander = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Clemenza", password: "hunter2hunter2" } });

    const res = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${bystander.json().token}` },
    });
    expect(res.statusCode).toBe(404);

    // Confirms it was rejected, not silently accepted for the wrong player.
    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, inviteeId));
    expect(stats?.gangId).toBeNull();
  });
});

describe("POST /api/gangs/invites/:inviteId/decline", () => {
  it("removes the invite without joining", async () => {
    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, inviteeId));

    const res = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/decline`, headers: { authorization: `Bearer ${inviteeToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(await db.select().from(gangInvites)).toHaveLength(0);

    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, inviteeId));
    expect(stats?.gangId).toBeNull();
  });

  it("404s declining an invite that belongs to a different player", async () => {
    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, inviteeId));
    const bystander = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Clemenza", password: "hunter2hunter2" } });

    const res = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/decline`, headers: { authorization: `Bearer ${bystander.json().token}` },
    });
    expect(res.statusCode).toBe(404);

    // Confirms it was rejected, not silently declined out from under the real invitee.
    expect(await db.select().from(gangInvites)).toHaveLength(1);
  });
});
