import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { gangInvites, gangLogs, gangs, playerStats } from "../src/db/schema/index.js";
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
let bossToken: string;
let bossId: string;
let gangId: string;
let memberToken: string;
let memberId: string;

async function joinGang(username: string): Promise<{ token: string; playerId: string }> {
  const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username });
  await app.inject({
    method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
    payload: { username },
  });
  const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, playerId));
  await app.inject({ method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${token}` } });
  return { token, playerId };
}

const transfer = (token: string, targetId: string, gang = gangId) =>
  app.inject({
    method: "POST", url: `/api/gangs/${gang}/transfer`, headers: { authorization: `Bearer ${token}` },
    payload: { playerId: targetId },
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());

  const boss = await registerVerifiedPlayer({ app, redis }, { username: "Vito" });
  ({ token: bossToken, playerId: bossId } = boss);
  const gang = await app.inject({
    method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${bossToken}` }, payload: { name: "The Corleones" },
  });
  gangId = gang.json().id;

  ({ token: memberToken, playerId: memberId } = await joinGang("Sonny"));
});

afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); });

describe("POST /api/gangs/:gangId/transfer", () => {
  it("hands leadership to another member and leaves the old boss a plain member", async () => {
    const res = await transfer(bossToken, memberId);
    expect(res.statusCode).toBe(204);

    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bossPlayerId).toBe(memberId);
    // The old boss is demoted, not removed — leave is a separate action.
    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, bossId));
    expect(stats?.gangId).toBe(gangId);
  });

  // The whole reason this route exists: before it, a boss hit
  // 409 boss_must_transfer_first on leave and had no way to satisfy it.
  it("unblocks the boss's leave, end to end", async () => {
    const blocked = await app.inject({ method: "POST", url: `/api/gangs/${gangId}/leave`, headers: { authorization: `Bearer ${bossToken}` } });
    expect(blocked.statusCode).toBe(409);

    expect((await transfer(bossToken, memberId)).statusCode).toBe(204);

    const left = await app.inject({ method: "POST", url: `/api/gangs/${gangId}/leave`, headers: { authorization: `Bearer ${bossToken}` } });
    expect(left.statusCode).toBe(204);

    const members = await app.inject({
      method: "GET", url: `/api/gangs/${gangId}/members`, headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(members.json().members).toHaveLength(1);
  });

  it("clears underboss_player_id when the target held that office", async () => {
    await db.update(gangs).set({ underbossPlayerId: memberId }).where(eq(gangs.id, gangId));

    expect((await transfer(bossToken, memberId)).statusCode).toBe(204);

    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bossPlayerId).toBe(memberId);
    // One player must not hold both offices: hasGangPermission's bypass reads
    // either column, so a leftover underboss row would make demoting the
    // underboss unable to remove their bypass.
    expect(gang?.underbossPlayerId).toBeNull();
  });

  it("leaves an unrelated underboss alone", async () => {
    const { playerId: underbossId } = await joinGang("Tom");
    await db.update(gangs).set({ underbossPlayerId: underbossId }).where(eq(gangs.id, gangId));

    expect((await transfer(bossToken, memberId)).statusCode).toBe(204);

    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.underbossPlayerId).toBe(underbossId);
  });

  it("records the transfer in the gang log", async () => {
    await transfer(bossToken, memberId);

    const [log] = await db.select().from(gangLogs).where(eq(gangLogs.gangId, gangId)).orderBy(desc(gangLogs.createdAt)).limit(1);
    expect(log?.playerId).toBe(bossId);
    expect(log?.message).toContain("Sonny");
  });

  it("notifies the new boss", async () => {
    // actorId is the notified player, matching the invite route — and what
    // CLAUDE.md rule 4's awaitOwnEvent filter keys on.
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = awaitOwnEvent(subscriber, memberId);
    await transfer(bossToken, memberId);

    const event = await received;
    expect(event.type).toBe("notification.created");
    expect(event.audience).toEqual({ kind: "player", playerId: memberId });

    const notifications = await app.inject({
      method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(JSON.stringify(notifications.json())).toContain("The Corleones");
  });

  it("403s a plain member trying to transfer to themselves", async () => {
    const res = await transfer(memberToken, memberId);
    expect(res.statusCode).toBe(403);

    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bossPlayerId).toBe(bossId);
  });

  it("403s an outsider, who is also not a member", async () => {
    const outsider = await registerVerifiedPlayer({ app, redis }, { username: "Barzini" });
    const res = await transfer(outsider.token, memberId);
    // Not-the-boss is answered before target membership, so this is 403 and
    // not 404: an outsider learns nothing about who is in the gang.
    expect(res.statusCode).toBe(403);
  });

  it("404s a target who is in no gang", async () => {
    // Never authenticates as the stranger below, just needs a real player row.
    const stranger = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Barzini", email: "barzini@example.test", password: "hunter2hunter2" } });
    const res = await transfer(bossToken, stranger.json().playerId);
    expect(res.statusCode).toBe(404);
  });

  it("404s a target who is in a different gang", async () => {
    const rival = await registerVerifiedPlayer({ app, redis }, { username: "Barzini" });
    const rivalToken: string = rival.token;
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${rivalToken}` }, payload: { name: "The Tattaglias" },
    });

    const res = await transfer(bossToken, rival.playerId);
    expect(res.statusCode).toBe(404);
    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bossPlayerId).toBe(bossId);
  });

  it("409s transferring to yourself", async () => {
    const res = await transfer(bossToken, bossId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_boss");
  });

  it("404s a gang that does not exist", async () => {
    const res = await transfer(bossToken, memberId, "00000000-0000-0000-0000-000000000000");
    expect(res.statusCode).toBe(404);
  });

  it("400s a playerId that isn't a uuid instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/transfer`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("401s without a token", async () => {
    const res = await app.inject({ method: "POST", url: `/api/gangs/${gangId}/transfer`, payload: { playerId: memberId } });
    expect(res.statusCode).toBe(401);
  });
});
