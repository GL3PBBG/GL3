import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(0, 8)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

/** Registers the sacrificial first player (auto-admin) plus a moderator with the `players` grant. */
async function bootMod(): Promise<{ token: string; playerId: string }> {
  await registerVerifiedPlayer({ app, redis }, { username: "FirstAdmin" });
  const mod = await registerVerifiedPlayer({ app, redis }, { username: "Moderator" });
  await giveRole(mod.playerId, "players");
  return mod;
}

function ban(
  modToken: string, body: { username: string; reason: string; expiresHours?: number },
): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return app.inject({
    method: "POST", url: "/api/admin/players/ban",
    headers: { authorization: `Bearer ${modToken}` }, payload: body,
  });
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("admin players: ban", () => {
  it("bans a player: sessions die and every authed request 403s banned", async () => {
    const mod = await bootMod();
    const target = await registerVerifiedPlayer({ app, redis }, { username: "Griefer" });

    const res = await ban(mod.token, { username: "Griefer", reason: "market abuse" });
    expect(res.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${target.token}` },
    });
    // The old session token is destroyed outright, so this is 401, not 403.
    expect(me.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "Griefer", password: "password123" },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ error: "banned", reason: "market abuse" });
  });

  it("gates an already-issued session that survived the kill", async () => {
    const mod = await bootMod();
    const target = await registerVerifiedPlayer({ app, redis }, { username: "Sneaky" });
    await ban(mod.token, { username: "Sneaky", reason: "alt account" });
    // Simulate a session the reverse index missed: mint one directly.
    await redis.set(`session:resurrected`, target.playerId, "EX", 60);
    const me = await app.inject({
      method: "GET", url: "/api/plugins", headers: { authorization: `Bearer resurrected` },
    });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toEqual({ error: "banned" });
  });

  it("login re-asserts the ban from the row after a Redis flush", async () => {
    const mod = await bootMod();
    await registerVerifiedPlayer({ app, redis }, { username: "Flushed" });
    await ban(mod.token, { username: "Flushed", reason: "row is truth" });
    const [row] = await db.select({ id: players.id }).from(players).where(eq(players.username, "Flushed"));
    await redis.del(`banned:${row!.id}`);
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "Flushed", password: "password123" },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ error: "banned" });
  });

  it("timed ban: flag carries a TTL and an expired ban self-heals at login", async () => {
    const mod = await bootMod();
    const target = await registerVerifiedPlayer({ app, redis }, { username: "Timed" });

    const res = await ban(mod.token, { username: "Timed", reason: "cool off", expiresHours: 2 });
    expect(res.statusCode).toBe(200);
    const ttl = await redis.ttl(`banned:${target.playerId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2 * 3600);

    // Fast-forward: expiry in the past, flag gone (as TTL would have taken it).
    await db.update(players).set({ banExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(players.id, target.playerId));
    await redis.del(`banned:${target.playerId}`);

    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "Timed", password: "password123" },
    });
    expect(login.statusCode).toBe(200);

    // Self-heal cleared the stale ban columns.
    const [row] = await db.select({ bannedAt: players.bannedAt, banReason: players.banReason })
      .from(players).where(eq(players.id, target.playerId));
    expect(row).toEqual({ bannedAt: null, banReason: null });
  });

  it("refuses banning yourself", async () => {
    const mod = await bootMod();
    const res = await ban(mod.token, { username: "Moderator", reason: "oops" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "cannot_ban_self" });
  });

  it("404s an unknown username", async () => {
    const mod = await bootMod();
    const res = await ban(mod.token, { username: "Nobody", reason: "ghost" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "player_not_found" });
  });

  it("403s without the players grant", async () => {
    await registerVerifiedPlayer({ app, redis }, { username: "FirstAdmin" });
    const p = await registerVerifiedPlayer({ app, redis }, { username: "MailMod" });
    await giveRole(p.playerId, "mail");
    const res = await ban(p.token, { username: "FirstAdmin", reason: "nope" });
    expect(res.statusCode).toBe(403);
  });
});

describe("admin players: unban", () => {
  it("clears the ban: login works again and the row is clean", async () => {
    const mod = await bootMod();
    const target = await registerVerifiedPlayer({ app, redis }, { username: "Forgiven" });
    await ban(mod.token, { username: "Forgiven", reason: "mistake" });

    const res = await app.inject({
      method: "POST", url: `/api/admin/players/${target.playerId}/unban`,
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(res.statusCode).toBe(200);

    expect(await redis.exists(`banned:${target.playerId}`)).toBe(0);
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "Forgiven", password: "password123" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("400s a malformed id and 404s an unknown one", async () => {
    const mod = await bootMod();
    const bad = await app.inject({
      method: "POST", url: "/api/admin/players/not-a-uuid/unban",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST", url: `/api/admin/players/${uuidv7()}/unban`,
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("admin players: table", () => {
  it("serves all-string rows with username, role, ban state and no id column", async () => {
    const mod = await bootMod();
    await registerVerifiedPlayer({ app, redis }, { username: "Bystander" });
    await ban(mod.token, { username: "Bystander", reason: "spam" });

    const res = await app.inject({
      method: "GET", url: "/api/admin/players/table",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = res.json() as { rows: Record<string, unknown>[] };
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      for (const value of Object.values(row)) expect(typeof value).toBe("string");
    }
    const banned = rows.find((r) => r.username === "Bystander");
    expect(banned?.banned).toContain("spam");
    const admin = rows.find((r) => r.username === "FirstAdmin");
    expect(admin?.role).toBe("Administrator");
  });

  it("lists a banned player even when 50 fresher unbanned players outrank them", async () => {
    const mod = await bootMod();
    await registerVerifiedPlayer({ app, redis }, { username: "OldSinner" });
    await ban(mod.token, { username: "OldSinner", reason: "ancient crime" });
    // Push the banned row past any recency cutoff.
    const [sinner] = await db.select({ id: players.id }).from(players).where(eq(players.username, "OldSinner"));
    await db.update(players).set({ lastSeenAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(players.id, sinner!.id));
    for (let i = 0; i < 50; i++) {
      const filler = uuidv7();
      await db.insert(players).values({ id: filler, username: `filler_${i}`, lastSeenAt: new Date() });
    }
    const res = await app.inject({
      method: "GET", url: "/api/admin/players/table",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    const { rows } = res.json() as { rows: { username: string }[] };
    expect(rows.some((r) => r.username === "OldSinner")).toBe(true);
  });
});

describe("admin players: section listing", () => {
  it("appears in /api/admin/plugins for the players grant only", async () => {
    const mod = await bootMod();
    const withGrant = await app.inject({
      method: "GET", url: "/api/admin/plugins",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(withGrant.statusCode).toBe(200);
    const sections = (withGrant.json() as { sections: { pluginId: string }[] }).sections;
    expect(sections.some((s) => s.pluginId === "players")).toBe(true);

    const other = await registerVerifiedPlayer({ app, redis }, { username: "RoundsOnly" });
    await giveRole(other.playerId, "rounds");
    const without = await app.inject({
      method: "GET", url: "/api/admin/plugins",
      headers: { authorization: `Bearer ${other.token}` },
    });
    const otherSections = (without.json() as { sections: { pluginId: string }[] }).sections;
    expect(otherSections.some((s) => s.pluginId === "players")).toBe(false);
  });

  it("players is a grantable module key", async () => {
    const mod = await bootMod();
    const res = await app.inject({
      method: "GET", url: "/api/admin/roles/modules",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    // The modules select is gated on the roles grant, not players — use the
    // first admin (wildcard) instead.
    expect(res.statusCode).toBe(403);
    const [admin] = await db.select({ id: players.id }).from(players).where(eq(players.username, "FirstAdmin"));
    void admin;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "FirstAdmin", password: "password123" },
    });
    const adminToken = (login.json() as { token: string }).token;
    const modules = await app.inject({
      method: "GET", url: "/api/admin/roles/modules",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(modules.statusCode).toBe(200);
    const { rows } = modules.json() as { rows: { id: string }[] };
    expect(rows.some((r) => r.id === "players")).toBe(true);
  });
});
