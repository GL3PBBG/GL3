import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangs, locations, playerStats, players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { PRESENCE_KEY } from "../src/presence/touch.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, redis, close: closeServer } = await bootTestServer());
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const del = (token: string, password: string) =>
  app.inject({ method: "POST", url: "/api/auth/delete", headers: auth(token), payload: { password } });

describe("POST /api/auth/delete", () => {
  it("401 without a session; 401 invalid_credentials on the wrong password", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/delete", payload: { password: "x" } })).statusCode).toBe(401);
    // Two players so neither is the sole admin.
    await registerVerifiedPlayer({ app, redis });
    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { password: "password123" });
    const res = await del(token, "wrong");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
    expect((await db.select({ id: players.id }).from(players).where(eq(players.id, playerId))).length).toBe(1);
  });

  it("409 sole_administrator for the only * holder; 204 once a second admin exists", async () => {
    const first = await registerVerifiedPlayer({ app, redis }, { password: "password123" });
    const second = await registerVerifiedPlayer({ app, redis });
    const refused = await del(first.token, "password123");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "sole_administrator" });

    // Hand `second` the Administrator role directly — the roles route refuses
    // self-demotion but assigning another player is fine; a raw update is
    // shorter and this test is not about the roles route.
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Administrator"));
    await db.update(players).set({ roleId: adminRole!.id }).where(eq(players.id, second.playerId));

    expect((await del(first.token, "password123")).statusCode).toBe(204);
  });

  it("a `roles` grant counts as an administrator for the guard", async () => {
    const first = await registerVerifiedPlayer({ app, redis }, { password: "password123" });
    const second = await registerVerifiedPlayer({ app, redis });
    const modRoleId = "00000000-0000-7000-8000-000000000ab1";
    await db.insert(roles).values({ id: modRoleId, name: "RoleManager" });
    await db.insert(roleModuleAccess).values({ roleId: modRoleId, moduleKey: "roles" });
    await db.update(players).set({ roleId: modRoleId }).where(eq(players.id, second.playerId));
    expect((await del(first.token, "password123")).statusCode).toBe(204);
  });

  it("removes the row, cascades, set-nulls the gang boss, and clears Redis", async () => {
    await registerVerifiedPlayer({ app, redis }); // first = admin, stays
    const boss = await registerVerifiedPlayer({ app, redis }, { password: "password123", username: "Vito" });
    const gang = await app.inject({ method: "POST", url: "/api/gangs", headers: auth(boss.token), payload: { name: "Corleones" } });
    expect(gang.statusCode).toBe(201);
    const gangId = gang.json().id as string;

    // Presence + leaderboard membership exist because /me and register touched them.
    await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(boss.token) });
    expect(await redis.zscore(PRESENCE_KEY, boss.playerId)).not.toBeNull();

    const second = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "Vito", password: "password123" } });
    const secondToken = second.json().token as string;

    const res = await del(boss.token, "password123");
    expect(res.statusCode).toBe(204);

    expect(await db.select({ id: players.id }).from(players).where(eq(players.id, boss.playerId))).toEqual([]);
    expect(await db.select({ id: playerStats.playerId }).from(playerStats).where(eq(playerStats.playerId, boss.playerId))).toEqual([]);
    const [g] = await db.select({ boss: gangs.bossPlayerId }).from(gangs).where(eq(gangs.id, gangId));
    expect(g?.boss).toBeNull();

    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(boss.token) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(secondToken) })).statusCode).toBe(401);
    expect(await redis.zscore(PRESENCE_KEY, boss.playerId)).toBeNull();
    expect(await redis.exists(`playersessions:${boss.playerId}`, `unverified:${boss.playerId}`, `lastseenmark:${boss.playerId}`)).toBe(0);
    // Leaderboard: the board no longer lists the name.
    const board = await app.inject({ method: "GET", url: "/api/leaderboard/cash" });
    expect(JSON.stringify(board.json())).not.toContain("Vito");
  });

  it("plugin tables: cascade (combat log) and set-null (property owner) both hold", async () => {
    // Proven at the FK level with raw inserts — cheaper than driving a kill
    // and a franchise purchase, and it is the FK behaviour under test.
    await registerVerifiedPlayer({ app, redis });
    const victim = await registerVerifiedPlayer({ app, redis }, { password: "password123" });
    const other = await registerVerifiedPlayer({ app, redis });
    // resetDb() truncates every table including locations, and this file
    // boots the server once (guarded `if (!app)`) — the boot-time seed does
    // not run again, so a location has to be inserted here, not just read.
    const locationId = "00000000-0000-7000-8000-0000000000d1";
    await db.insert(locations).values({ id: locationId, name: "Testville" });
    await conn`insert into p_combat_log (id, attacker_id, target_id, hit, damage, fatal, created_at)
               values (gen_random_uuid(), ${victim.playerId}::uuid, ${other.playerId}::uuid, true, 1, false, now())`;
    const propId = "00000000-0000-7000-8000-0000000000c1";
    await conn`insert into p_properties_properties (id, location_id, plugin_id, owner_player_id, cost)
               values (${propId}::uuid, ${locationId}::uuid, 'blackjack', ${victim.playerId}::uuid, 100)`;

    expect((await del(victim.token, "password123")).statusCode).toBe(204);

    expect((await conn`select 1 from p_combat_log where attacker_id = ${victim.playerId}::uuid`).length).toBe(0);
    const [prop] = await conn<{ owner_player_id: string | null }[]>`select owner_player_id from p_properties_properties where id = ${propId}::uuid`;
    expect(prop?.owner_player_id).toBeNull();
  });

  it("an unverified player can delete (gate-exempt)", async () => {
    await registerVerifiedPlayer({ app, redis });
    const username = `uv_${Date.now()}`;
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username, email: `${username}@example.test`, password: "password123", acceptTerms: true } });
    expect((await del(reg.json().token as string, "password123")).statusCode).toBe(204);
  });
});
