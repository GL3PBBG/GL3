import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { GangMemberListResponseSchema, GangPermissionSchema } from "@gl3/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangInvites, gangPermissions, gangs } from "../src/db/schema/index.js";
import { GANG_PERMISSIONS } from "../src/game/gangs/permissions.js";
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

// The DTO enum and the server tuple are two hand-maintained copies of one
// list. Drift would not fail a typecheck — the roster would just serve a
// permission the shared schema rejects, and every client parse of the
// roster would throw — so assert the parity instead of leaving it to a
// comment in gangs.ts.
it("keeps the shared GangPermission enum in step with the server's GANG_PERMISSIONS", () => {
  expect([...GangPermissionSchema.options].sort()).toEqual([...GANG_PERMISSIONS].sort());
});

describe("GET /api/gangs/:gangId/members", () => {
  it("returns the roster with derived roles", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/gangs/${gangId}/members`, headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(200);

    const { members } = GangMemberListResponseSchema.parse(res.json());
    expect(members).toHaveLength(2);
    // Boss first regardless of join order — the roster is the source a client
    // uses to decide which buttons to render, so the ordering is part of the
    // contract, not incidental.
    expect(members[0]?.playerId).toBe(bossId);
    expect(members[0]?.role).toBe("boss");
    expect(members[0]?.username).toBe("Vito");
    expect(members[1]?.playerId).toBe(memberId);
    expect(members[1]?.role).toBe("member");
  });

  it("reports the underboss role, which is a gangs column rather than a permission row", async () => {
    await db.update(gangs).set({ underbossPlayerId: memberId }).where(eq(gangs.id, gangId));

    const res = await app.inject({
      method: "GET", url: `/api/gangs/${gangId}/members`, headers: { authorization: `Bearer ${memberToken}` },
    });
    const { members } = GangMemberListResponseSchema.parse(res.json());
    expect(members.find((m) => m.playerId === memberId)?.role).toBe("underboss");
  });

  it("gives leadership every permission with no gang_permissions row to back it", async () => {
    expect(await db.select().from(gangPermissions).where(eq(gangPermissions.gangId, gangId))).toHaveLength(0);

    const res = await app.inject({
      method: "GET", url: `/api/gangs/${gangId}/members`, headers: { authorization: `Bearer ${memberToken}` },
    });
    const { members } = GangMemberListResponseSchema.parse(res.json());
    // Mirrors hasGangPermission's boss/underboss bypass: leadership holds
    // every permission implicitly, so an empty array here would tell a client
    // the boss can do nothing.
    expect([...members.find((m) => m.playerId === bossId)!.permissions].sort())
      .toEqual([...GANG_PERMISSIONS].sort());
    expect(members.find((m) => m.playerId === memberId)?.permissions).toEqual([]);
  });

  it("lists a granted permission for a plain member", async () => {
    const granted = await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: memberId, permission: "kick" },
    });
    expect(granted.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET", url: `/api/gangs/${gangId}/members`, headers: { authorization: `Bearer ${memberToken}` },
    });
    const { members } = GangMemberListResponseSchema.parse(res.json());
    expect(members.find((m) => m.playerId === memberId)?.permissions).toEqual(["kick"]);
  });

  // hasGangPermission masks a gang_permissions row that has no matching
  // gang_members row (its third layer). The roster must apply the same mask,
  // or it would advertise authority the server would refuse to honour.
  it("ignores a permission row belonging to someone who is not a member", async () => {
    const outsider = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Barzini", password: "hunter2hunter2" } });
    const outsiderId: string = outsider.json().playerId;
    await db.insert(gangPermissions).values({ gangId, playerId: outsiderId, permission: "kick" });

    const res = await app.inject({
      method: "GET", url: `/api/gangs/${gangId}/members`, headers: { authorization: `Bearer ${memberToken}` },
    });
    const { members } = GangMemberListResponseSchema.parse(res.json());
    expect(members.map((m) => m.playerId)).not.toContain(outsiderId);
  });

  it("403s a player who is not in the gang", async () => {
    const outsider = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Barzini", password: "hunter2hunter2" } });
    const res = await app.inject({
      method: "GET", url: `/api/gangs/${gangId}/members`, headers: { authorization: `Bearer ${outsider.json().token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s a nonexistent gang, not 403 — existence is checked before membership", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/gangs/00000000-0000-0000-0000-000000000000/members",
      headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a gangId that isn't a uuid instead of 500ing", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/gangs/not-a-uuid/members", headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("401s without a token", async () => {
    const res = await app.inject({ method: "GET", url: `/api/gangs/${gangId}/members` });
    expect(res.statusCode).toBe(401);
  });
});
