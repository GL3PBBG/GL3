import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { gangInvites, gangPermissions, playerStats } from "../src/db/schema/index.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let bossToken: string;
let bossId: string;
let gangId: string;
let memberToken: string;
let memberId: string;

async function joinGang(username: string): Promise<{ token: string; playerId: string }> {
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username, password: "hunter2hunter2" } });
  const { token, playerId } = reg.json();
  await app.inject({
    method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
    payload: { username },
  });
  const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, playerId));
  await app.inject({ method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${token}` } });
  return { token, playerId };
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  const boss = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
  ({ token: bossToken, playerId: bossId } = boss.json());
  const gang = await app.inject({
    method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${bossToken}` }, payload: { name: "The Corleones" },
  });
  gangId = gang.json().id;

  ({ token: memberToken, playerId: memberId } = await joinGang("Sonny"));
});

afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); });

describe("POST /api/gangs/:gangId/leave", () => {
  it("removes membership and clears player_stats.gang_id", async () => {
    const res = await app.inject({ method: "POST", url: `/api/gangs/${gangId}/leave`, headers: { authorization: `Bearer ${memberToken}` } });
    expect(res.statusCode).toBe(204);
    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, memberId));
    expect(stats?.gangId).toBeNull();
  });

  it("409s the boss leaving without transferring first", async () => {
    const res = await app.inject({ method: "POST", url: `/api/gangs/${gangId}/leave`, headers: { authorization: `Bearer ${bossToken}` } });
    expect(res.statusCode).toBe(409);
  });

  it("404s leaving a gang the caller isn't a member of, and does not clear their real membership", async () => {
    const otherBoss = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Barzini", password: "hunter2hunter2" } });
    const { token: otherBossToken } = otherBoss.json();
    const otherGang = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${otherBossToken}` }, payload: { name: "The Tattaglias" },
    });
    const otherGangId = otherGang.json().id;

    const res = await app.inject({ method: "POST", url: `/api/gangs/${otherGangId}/leave`, headers: { authorization: `Bearer ${memberToken}` } });
    expect(res.statusCode).toBe(404);
    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, memberId));
    expect(stats?.gangId).toBe(gangId);
  });
});

describe("DELETE /api/gangs/:gangId/members/:playerId", () => {
  it("lets the boss kick a member", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/members/${memberId}`, headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(res.statusCode).toBe(204);
    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, memberId));
    expect(stats?.gangId).toBeNull();
  });

  it("403s a member with no kick permission kicking another member", async () => {
    const { playerId: other } = await joinGang("Clemenza");
    const res = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/members/${other}`, headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s kicking against a nonexistent gang, not 403 — existence is checked before permission", async () => {
    const res = await app.inject({
      method: "DELETE", url: "/api/gangs/00000000-0000-0000-0000-000000000000/members/" + memberId,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // Regression coverage: gang.memberLeft's actor is documented (events.ts)
  // as "the member who joined / left" — for a kick that is the KICKED
  // player, not the kicker, matching gang.memberJoined's actor being the
  // joiner rather than whoever sent the invite. actorId drives
  // awaitOwnEvent filtering and the WS fan-out (NOTES.md rule 4), so if
  // this ever flipped to the kicker's id, the kicked player would silently
  // stop receiving the event telling them they were kicked, and nothing
  // else in this suite would catch it.
  it("publishes gang.memberLeft with the kicked player, not the kicker, as actor", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = awaitOwnEvent(subscriber, memberId);

    const res = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/members/${memberId}`, headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(res.statusCode).toBe(204);

    const event = await received;
    expect(event.type).toBe("gang.memberLeft");
    expect(event.actorId).toBe(memberId);
    expect(event.actorId).not.toBe(bossId);
  });

  it("404s kicking a player who belongs to a different gang, and does not clear their real membership", async () => {
    const otherBoss = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Barzini", password: "hunter2hunter2" } });
    const { token: otherBossToken, playerId: otherBossId } = otherBoss.json();
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${otherBossToken}` }, payload: { name: "The Tattaglias" },
    });
    const [otherStats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, otherBossId));
    const otherGangId = otherStats!.gangId!;

    const res = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/members/${otherBossId}`, headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(res.statusCode).toBe(404);
    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, otherBossId));
    expect(stats?.gangId).toBe(otherGangId);
  });
});

describe("PUT /api/gangs/:gangId/permissions", () => {
  it("lets the boss grant a permission, enabling that action", async () => {
    const grant = await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: memberId, permission: "kick" },
    });
    expect(grant.statusCode).toBe(204);

    const { playerId: other } = await joinGang("Clemenza");
    const kick = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/members/${other}`, headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(kick.statusCode).toBe(204);
  });

  it("403s a non-boss/underboss granting a permission", async () => {
    const res = await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${memberToken}` },
      payload: { playerId: memberId, permission: "kick" },
    });
    expect(res.statusCode).toBe(403);
  });

  // Grant-to-a-non-member used to be accepted (204) and stored. It conferred
  // nothing at the time, because hasGangPermission inner-joins gang_members —
  // but nothing deleted the row either, so it lay dormant and activated the
  // instant the target joined. Rejecting the grant is the first of the two
  // layers that close that: no dormant row is ever created. 404 rather than
  // 403/409 matches what kick and leave already answer for the identical
  // "this player is not in this gang" condition.
  it("404s a permission granted to a player who is not a member of the gang, storing no dormant row", async () => {
    const outsider = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Fredo", password: "hunter2hunter2" } });
    const { playerId: outsiderId } = outsider.json();

    const grant = await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: outsiderId, permission: "kick" },
    });
    expect(grant.statusCode).toBe(404);
    expect(await db.select().from(gangPermissions).where(eq(gangPermissions.playerId, outsiderId))).toHaveLength(0);
  });

  // The third layer, kept covered independently of the route: even if a
  // gang_permissions row for a non-member exists from some other source (an
  // ops write, or a future code path), hasGangPermission's membership join
  // must still refuse it.
  it("a dangling permission row for a non-member confers no authority even when it exists", async () => {
    const outsider = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Fredo", password: "hunter2hunter2" } });
    const { token: outsiderToken, playerId: outsiderId } = outsider.json();
    await db.insert(gangPermissions).values({ gangId, playerId: outsiderId, permission: "kick" });

    const kick = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/members/${memberId}`, headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(kick.statusCode).toBe(403);
    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, memberId));
    expect(stats?.gangId).toBe(gangId);
  });

  // The second layer. Rejecting the grant stops the invite route from
  // planting a dormant row, but it cannot retire rows that already exist or
  // that a future admin/import path creates, and joining is the moment such
  // a row would silently become live. accept-invite therefore clears the
  // (gangId, playerId) permission rows inside its own transaction — the
  // mirror of removeMember, which already clears them on the way out.
  it("clears a dormant permission row for the joining player when they accept an invite", async () => {
    const outsider = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Fredo", password: "hunter2hunter2" } });
    const { token: outsiderToken, playerId: outsiderId } = outsider.json();
    await db.insert(gangPermissions).values({ gangId, playerId: outsiderId, permission: "kick" });

    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Fredo" },
    });
    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, outsiderId));
    const accept = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(accept.statusCode).toBe(200);

    expect(await db.select().from(gangPermissions).where(eq(gangPermissions.playerId, outsiderId))).toHaveLength(0);
    // And the permission is genuinely not held now that they ARE a member.
    const kick = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/members/${memberId}`, headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(kick.statusCode).toBe(403);
  });

  it("404s a nonexistent gang, not 403 — existence is checked before permission", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/gangs/00000000-0000-0000-0000-000000000000/permissions",
      headers: { authorization: `Bearer ${bossToken}` }, payload: { playerId: memberId, permission: "kick" },
    });
    expect(res.statusCode).toBe(404);
  });

  // Answered by the membership check since the dangling-grant fix (a player
  // with no gang_members row cannot be granted anything, existent or not);
  // gang_permissions.player_id's FK catch remains behind it as a backstop.
  // Either way the property under test is unchanged: a syntactically valid
  // but nonexistent player id must be a clean 4xx, never an uncaught 500.
  it("4xxs a syntactically valid but nonexistent player id instead of 500ing", async () => {
    const res = await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: "00000000-0000-0000-0000-000000000000", permission: "kick" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe("DELETE /api/gangs/:gangId/permissions/:playerId/:permission", () => {
  it("revokes a previously granted permission", async () => {
    await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: memberId, permission: "kick" },
    });
    const res = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/permissions/${memberId}/kick`, headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(await db.select().from(gangPermissions)).toHaveLength(0);
  });

  it("404s a nonexistent gang, not 403 — existence is checked before permission", async () => {
    const res = await app.inject({
      method: "DELETE", url: "/api/gangs/00000000-0000-0000-0000-000000000000/permissions/" + memberId + "/kick",
      headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
