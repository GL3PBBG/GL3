import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangInvites, gangPermissions, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
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

afterAll(async () => { await closeServer(); await conn.end(); });

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
});
