import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { GangInviteListResponseSchema, ServerFrameSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import WebSocket from "ws";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { gangInvites, playerStats } from "../src/db/schema/index.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let redis: Redis;
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
    ({ app, close: closeServer, redis } = await bootTestServer());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}/ws`;
  }

  ({ token: bossToken, playerId: bossId } = await registerVerifiedPlayer({ app, redis }, { username: "Vito" }));
  ({ token: inviteeToken, playerId: inviteeId } = await registerVerifiedPlayer({ app, redis }, { username: "Sonny" }));

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

/**
 * Resolves with the next frame matching `predicate` (default: any frame),
 * silently discarding anything else along the way.
 *
 * `game:events` is a single Redis channel shared by every test file running
 * concurrently, and the gateway broadcasts every `global`-audience event
 * (e.g. `news.posted`) to *every* connected socket regardless of who it's
 * "for" (gateway.ts's `route`, "global" case) — so an unfiltered `nextFrame`
 * can consume a stranger's frame instead of the one this test is actually
 * waiting for. This is the WS-socket-level equivalent of NOTES.md rule 4
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

/** Matches a `notification.created` server frame whose actor is `actorId` — see nextFrame's predicate. */
const isNotificationFor = (actorId: string) => (frame: unknown): boolean => {
  const parsed = ServerFrameSchema.safeParse(frame);
  return parsed.success && parsed.data.kind === "event"
    && parsed.data.event.type === "notification.created" && parsed.data.event.actorId === actorId;
};

/** Matches a `gang.memberJoined` server frame for `gangId` — see nextFrame's predicate. */
const isMemberJoinedFor = (gangId: string) => (frame: unknown): boolean => {
  const parsed = ServerFrameSchema.safeParse(frame);
  return parsed.success && parsed.data.kind === "event"
    && parsed.data.event.type === "gang.memberJoined" && parsed.data.event.gangId === gangId;
};

describe("POST /api/gangs/:gangId/invites", () => {
  it("invites a player and notifies them live over WS", async () => {
    const ticket = await mintTicket(inviteeToken);
    const socket = await open(`${baseUrl}?ticket=${ticket}`);
    await nextFrame(socket); // ready
    const incoming = nextFrame(socket, isNotificationFor(inviteeId));

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
    const other = await registerVerifiedPlayer({ app, redis }, { username: "Clemenza" });
    // Clemenza isn't a member of the gang at all yet.
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${other.token}` },
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
    const incoming = nextFrame(bossSocket, isMemberJoinedFor(gangId));

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
    const bystander = await registerVerifiedPlayer({ app, redis }, { username: "Clemenza" });

    const res = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${bystander.token}` },
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
    const bystander = await registerVerifiedPlayer({ app, redis }, { username: "Clemenza" });

    const res = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/decline`, headers: { authorization: `Bearer ${bystander.token}` },
    });
    expect(res.statusCode).toBe(404);

    // Confirms it was rejected, not silently declined out from under the real invitee.
    expect(await db.select().from(gangInvites)).toHaveLength(1);
  });
});

describe("GET /api/gangs/invites", () => {
  const invite = (username: string) =>
    app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username },
    });

  it("lists the requester's pending invites with the gang and inviter named", async () => {
    await invite("Sonny");

    const res = await app.inject({ method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${inviteeToken}` } });
    expect(res.statusCode).toBe(200);

    const { invites } = GangInviteListResponseSchema.parse(res.json());
    expect(invites).toHaveLength(1);
    // The notification the invitee receives is prose with no id in it, so
    // these fields are the only way a client can call accept or decline.
    expect(invites[0]?.gangId).toBe(gangId);
    expect(invites[0]?.gangName).toBe("The Corleones");
    expect(invites[0]?.invitedByPlayerId).toBe(bossId);
    expect(invites[0]?.invitedByUsername).toBe("Vito");

    // The point of the endpoint: the id it reports is one accept will take.
    const accepted = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invites[0]!.id}/accept`, headers: { authorization: `Bearer ${inviteeToken}` },
    });
    expect(accepted.statusCode).toBe(200);
  });

  // Shares a prefix with GET /api/gangs/:gangId. find-my-way prefers the
  // static segment, but "invites" reaching the :gangId handler would answer
  // 400 invalid_request and break the join loop silently, so pin it.
  it("is not shadowed by GET /api/gangs/:gangId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${inviteeToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ invites: [] });
  });

  it("shows only the requester's own invites", async () => {
    await invite("Sonny");
    const bystander = await registerVerifiedPlayer({ app, redis }, { username: "Clemenza" });

    const theirs = await app.inject({
      method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${bystander.token}` },
    });
    expect(GangInviteListResponseSchema.parse(theirs.json()).invites).toHaveLength(0);

    // Both halves, so an endpoint that returned nothing at all could not
    // pass this by satisfying only the first.
    const mine = await app.inject({ method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${inviteeToken}` } });
    expect(GangInviteListResponseSchema.parse(mine.json()).invites).toHaveLength(1);
  });

  it("drops an invite once it is declined", async () => {
    await invite("Sonny");
    const [row] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, inviteeId));
    await app.inject({
      method: "POST", url: `/api/gangs/invites/${row!.id}/decline`, headers: { authorization: `Bearer ${inviteeToken}` },
    });

    const res = await app.inject({ method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${inviteeToken}` } });
    expect(GangInviteListResponseSchema.parse(res.json()).invites).toHaveLength(0);
  });

  // Accepting deletes every invite the joiner holds (the accept route's
  // `delete(gangInvites).where(invitedPlayerId = ...)`), so a competing
  // gang's invite disappears too rather than lingering as a dead entry.
  it("empties once any invite is accepted, including other gangs' invites", async () => {
    await invite("Sonny");

    const rival = await registerVerifiedPlayer({ app, redis }, { username: "Barzini" });
    const rivalToken: string = rival.token;
    const rivalGang = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${rivalToken}` }, payload: { name: "The Tattaglias" },
    });
    await app.inject({
      method: "POST", url: `/api/gangs/${rivalGang.json().id}/invites`, headers: { authorization: `Bearer ${rivalToken}` },
      payload: { username: "Sonny" },
    });

    const before = await app.inject({ method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${inviteeToken}` } });
    expect(GangInviteListResponseSchema.parse(before.json()).invites).toHaveLength(2);

    const [corleone] = await db.select().from(gangInvites).where(eq(gangInvites.gangId, gangId));
    await app.inject({
      method: "POST", url: `/api/gangs/invites/${corleone!.id}/accept`, headers: { authorization: `Bearer ${inviteeToken}` },
    });

    const after = await app.inject({ method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${inviteeToken}` } });
    expect(GangInviteListResponseSchema.parse(after.json()).invites).toHaveLength(0);
  });

  // The one shape that survives that cleanup: the invite route reads the
  // target's gang_id unlocked, so an insert can land just after an accept's
  // delete. Inserted directly here because no pair of requests can be
  // interleaved to order on demand. The list must report it — the accept
  // route is the authority on whether an invite still works, and filtering
  // it out would leave the invitee holding a notification for an invite
  // that appears nowhere.
  it("lists a raced invite that would now 409 on accept", async () => {
    await invite("Sonny");
    const [corleone] = await db.select().from(gangInvites).where(eq(gangInvites.gangId, gangId));
    await app.inject({
      method: "POST", url: `/api/gangs/invites/${corleone!.id}/accept`, headers: { authorization: `Bearer ${inviteeToken}` },
    });

    const rival = await registerVerifiedPlayer({ app, redis }, { username: "Barzini" });
    const rivalToken: string = rival.token;
    const rivalGang = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${rivalToken}` }, payload: { name: "The Tattaglias" },
    });
    await db.insert(gangInvites).values({
      id: randomUUID(), gangId: rivalGang.json().id,
      invitedPlayerId: inviteeId, invitedByPlayerId: rival.playerId,
    });

    const res = await app.inject({ method: "GET", url: "/api/gangs/invites", headers: { authorization: `Bearer ${inviteeToken}` } });
    const { invites } = GangInviteListResponseSchema.parse(res.json());
    expect(invites).toHaveLength(1);
    expect(invites[0]?.gangName).toBe("The Tattaglias");

    const stale = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invites[0]!.id}/accept`, headers: { authorization: `Bearer ${inviteeToken}` },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("401s without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/gangs/invites" });
    expect(res.statusCode).toBe(401);
  });
});
