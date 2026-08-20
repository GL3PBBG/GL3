import membershipPlugin, { isMember, membershipUntil } from "@gl3/plugin-membership";
import type { FastifyInstance } from "fastify";
import type { Redis as IORedis } from "ioredis";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, describe, expect, it } from "vitest";
import { players, playerStats } from "../src/db/schema/index.js";
import { loadConfig } from "../src/config.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis } from "../src/redis.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(async () => { await conn.end(); redis.disconnect(); });

describe("membership migrations", () => {
  it("creates p_membership_packages", async () => {
    await runPluginMigrations(db, [membershipPlugin]);
    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables WHERE tablename = 'p_membership_packages'`);
    expect(tables).toHaveLength(1);
  });
});

async function createPlayer(): Promise<{ id: string }> {
  const id = uuidv7();
  // Whole uuid, not a prefix: uuidv7's leading hex is the millisecond
  // timestamp, so two players minted in the same tick collide on the
  // `players_username_unique` index (see plugin-tx-timers.test.ts).
  const username = `mship${id}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id };
}

const deps = (): Parameters<typeof createPluginCtx>[0] =>
  ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: `mship-test-${uuidv7()}` });
const opts = {
  pluginId: "membership", player: null, job: null, filters: [], propertyTypes: new Map(),
  installedPluginIds: new Set<string>(),
};

async function notificationCount(playerId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS count FROM notifications WHERE player_id = ${playerId}`);
  return Number(rows[0]?.count ?? 0);
}

describe("membershipUntil / isMember", () => {
  it("returns the live expiry for a live timer", async () => {
    const player = await createPlayer();
    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() + interval '1 hour')`);

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      const until = await membershipUntil(tx, player.id);
      expect(until).toBeInstanceOf(Date);
      expect(await isMember(tx, player.id)).toBe(true);
    });
  });

  it("expires lazily: deletes the row and sends exactly one notification", async () => {
    const player = await createPlayer();
    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() - interval '1 hour')`);

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
    });

    const remaining = await db.execute(sql`
      SELECT 1 FROM player_timers WHERE player_id = ${player.id} AND key = 'membership'`);
    expect(remaining).toHaveLength(0);
    expect(await notificationCount(player.id)).toBe(1);
  });

  it("a second call after expiry stays null and sends no further notification", async () => {
    const player = await createPlayer();
    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() - interval '1 hour')`);

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
    });
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
      expect(await isMember(tx, player.id)).toBe(false);
    });

    expect(await notificationCount(player.id)).toBe(1);
  });

  it("no row at all returns null and sends no notification", async () => {
    const player = await createPlayer();

    const ctx = createPluginCtx(deps(), opts);
    await ctx.transaction(async (tx) => {
      expect(await membershipUntil(tx, player.id)).toBeNull();
      expect(await isMember(tx, player.id)).toBe(false);
    });

    expect(await notificationCount(player.id)).toBe(0);
  });
});

describe("membership routes", () => {
  let app: FastifyInstance;
  let redis: IORedis;
  let closeServer: () => Promise<void>;

  afterAll(async () => {
    await closeServer?.();
  });

  /** Registers a player and returns their id plus a bearer token. */
  async function register(): Promise<{ id: string; token: string }> {
    const username = `mship_${randomUUID().slice(0, 8)}`;
    const body = await registerVerifiedPlayer({ app, redis }, { username });
    return { id: body.playerId, token: body.token };
  }

  async function seedPackage(costPoints: number, durationSeconds: number, name = "Gold"): Promise<string> {
    const id = uuidv7();
    await db.execute(sql`
      INSERT INTO p_membership_packages (id, name, cost_points, duration_seconds)
      VALUES (${id}, ${name}, ${costPoints}, ${durationSeconds})`);
    return id;
  }

  async function seedPoints(playerId: string, points: number): Promise<void> {
    await db.execute(sql`UPDATE player_stats SET points = ${points} WHERE player_id = ${playerId}`);
  }

  async function pointsOf(playerId: string): Promise<number> {
    const rows = await db.execute(sql`SELECT points FROM player_stats WHERE player_id = ${playerId}`);
    return Number(rows[0]?.points ?? 0);
  }

  async function membershipExpiry(playerId: string): Promise<Date | null> {
    const rows = await db.execute(sql`
      SELECT expires_at FROM player_timers WHERE player_id = ${playerId} AND key = 'membership'`);
    const row = rows[0] as { expires_at: string } | undefined;
    return row === undefined ? null : new Date(row.expires_at);
  }

  it("GET /api/membership/packages lists a seeded package", async () => {
    ({ app, close: closeServer, redis } = await bootTestServer());

    const packageId = await seedPackage(500, 3600, "Silver");
    const player = await register();

    const res = await app.inject({
      method: "GET",
      url: "/api/membership/packages",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json<{ rows: Array<{ id: string; name: string; costPoints: string; duration: string }> }>()
      .rows.find((r) => r.id === packageId);
    expect(row).toMatchObject({ name: "Silver", costPoints: "500", duration: "1 hour" });
  });

  it("GET /api/membership/status: no timer -> Not a member; live timer -> Active with ISO expiresAt", async () => {
    const player = await register();

    const noTimer = await app.inject({
      method: "GET",
      url: "/api/membership/status",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(noTimer.statusCode).toBe(200);
    expect(noTimer.json()).toEqual({ rows: [{ status: "Not a member", expiresAt: "—" }] });

    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() + interval '1 hour')`);

    const active = await app.inject({
      method: "GET",
      url: "/api/membership/status",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(active.statusCode).toBe(200);
    const body = active.json<{ rows: Array<{ status: string; expiresAt: string }> }>();
    expect(body.rows[0]?.status).toBe("Active");
    expect(() => new Date(body.rows[0]?.expiresAt ?? "")).not.toThrow();
    expect(Number.isNaN(new Date(body.rows[0]?.expiresAt ?? "").getTime())).toBe(false);
  });

  it("GET /api/membership/status with an expired timer reports Not a member and sends the notification", async () => {
    const player = await register();
    await db.execute(sql`
      INSERT INTO player_timers (player_id, key, expires_at)
      VALUES (${player.id}, 'membership', now() - interval '1 hour')`);

    const res = await app.inject({
      method: "GET",
      url: "/api/membership/status",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rows: [{ status: "Not a member", expiresAt: "—" }] });
    expect(await notificationCount(player.id)).toBe(1);
  });

  it("GET /api/membership/benefits returns an empty list for now", async () => {
    const player = await register();
    const res = await app.inject({
      method: "GET",
      url: "/api/membership/benefits",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rows: [] });
  });

  it("POST /api/membership/buy debits points and sets the timer", async () => {
    const packageId = await seedPackage(300, 7200, "Bronze");
    const player = await register();
    await seedPoints(player.id, 1000);

    const res = await app.inject({
      method: "POST",
      url: "/api/membership/buy",
      headers: { authorization: `Bearer ${player.token}` },
      payload: { packageId },
    });
    expect(res.statusCode).toBe(200);

    expect(await pointsOf(player.id)).toBe(700);
    const expiry = await membershipExpiry(player.id);
    expect(expiry).not.toBeNull();
    const expectedMs = Date.now() + 7200 * 1000;
    expect(Math.abs((expiry as Date).getTime() - expectedMs)).toBeLessThan(10_000);
  });

  it("buying again while active stacks from the live expiry", async () => {
    const packageId = await seedPackage(100, 3600, "Stacker");
    const player = await register();
    await seedPoints(player.id, 1000);

    const first = await app.inject({
      method: "POST",
      url: "/api/membership/buy",
      headers: { authorization: `Bearer ${player.token}` },
      payload: { packageId },
    });
    expect(first.statusCode).toBe(200);
    const firstExpiry = await membershipExpiry(player.id);
    expect(firstExpiry).not.toBeNull();

    const second = await app.inject({
      method: "POST",
      url: "/api/membership/buy",
      headers: { authorization: `Bearer ${player.token}` },
      payload: { packageId },
    });
    expect(second.statusCode).toBe(200);
    const secondExpiry = await membershipExpiry(player.id);
    expect(secondExpiry).not.toBeNull();

    const expectedMs = (firstExpiry as Date).getTime() + 3600 * 1000;
    expect(Math.abs((secondExpiry as Date).getTime() - expectedMs)).toBeLessThan(10_000);
  });

  it("insufficient points -> 409 insufficient_points, timer unchanged", async () => {
    const packageId = await seedPackage(10_000, 3600, "Platinum");
    const player = await register();
    await seedPoints(player.id, 5);

    const res = await app.inject({
      method: "POST",
      url: "/api/membership/buy",
      headers: { authorization: `Bearer ${player.token}` },
      payload: { packageId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_points" });
    expect(await pointsOf(player.id)).toBe(5);
    expect(await membershipExpiry(player.id)).toBeNull();
  });

  it("unknown packageId -> 404 package_not_found", async () => {
    const player = await register();
    await seedPoints(player.id, 1000);

    const res = await app.inject({
      method: "POST",
      url: "/api/membership/buy",
      headers: { authorization: `Bearer ${player.token}` },
      payload: { packageId: uuidv7() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "package_not_found" });
  });
});
