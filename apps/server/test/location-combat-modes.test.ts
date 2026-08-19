import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangMembers, gangs, locations, players, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { detectiveSearches } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

/**
 * Puts the given players in one fresh location, stamped with `mode`. Modelled
 * on `combat.test.ts`'s `makeAttackable`, with the mode addition this file
 * needs.
 */
async function makeAttackable(mode: "open" | "underground", ...ids: string[]): Promise<string> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
    combatMode: mode,
  });
  await db
    .update(playerStats)
    .set({
      locationId,
      exp: 100_000n,
      bullets: 1000n,
      health: 100,
      gangId: null,
      jailedUntil: null,
      hospitalUntil: null,
    })
    .where(inArray(playerStats.playerId, ids));
  return locationId;
}

/** A live report: succeeded, revealed, unexpired. Overrides shape the negatives. */
async function seedReport(
  hirer: string,
  target: string,
  over: Partial<typeof detectiveSearches.$inferInsert> = {},
): Promise<void> {
  const now = Date.now();
  await db.insert(detectiveSearches).values({
    id: uuidv7(),
    playerId: hirer,
    targetPlayerId: target,
    detectives: 1,
    endsAt: new Date(now - 3_600_000),
    succeeded: true,
    expiresAt: new Date(now + 3_600_000),
    ...over,
  });
}

/**
 * Registers a fresh player and returns their id, bearer token and username.
 * POST /api/auth/register is rate-limited to 5/hour/IP (`auth/routes.ts:51`),
 * and the outer `beforeEach` below spends 2 of those 5 already — a test has 3
 * of its own `register()` calls to spend, not 5. Use `makeStranger` for any
 * player that never needs to authenticate.
 */
async function register(): Promise<{ id: string; token: string; username: string }> {
  const username = `p-${uuidv7().slice(-8)}`;
  const body = await registerVerifiedPlayer({ app, redis }, { username });
  return { id: body.playerId, token: body.token, username: body.username };
}

/**
 * Inserts a bare player + stats row directly, bypassing password hashing and
 * the registration rate limit above.
 */
async function makeStranger(): Promise<{ id: string; username: string }> {
  const id = uuidv7();
  const username = `s-${id.slice(-8)}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id, username };
}

const attack = (token: string, targetId: string) =>
  app.inject({
    method: "POST",
    url: `/api/combat/attack/${targetId}`,
    headers: { authorization: `Bearer ${token}` },
  });

let a: { id: string; token: string; username: string };
let t: { id: string; username: string };

// `t`'s token is never used below — every attack is issued as `a` — so `t`
// is a stranger, not a registration. That leaves 4 of the file's 5/hour/IP
// budget free per test body for anything a test still needs to register.
beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  a = await register();
  t = await makeStranger();
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("underground town attack gate", () => {
  it("open town: attack works exactly as shipped", async () => {
    await makeAttackable("open", a.id, t.id);
    expect((await attack(a.token, t.id)).statusCode).toBe(200);
  });

  it("underground, no report: 409 no_detective_report and the cooldown is burned", async () => {
    await makeAttackable("underground", a.id, t.id);
    const res = await attack(a.token, t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_detective_report");
    // Burned: an immediate retry hits the cooldown, not the report check.
    expect((await attack(a.token, t.id)).statusCode).toBe(429);
  });

  it("underground, pending report: 409", async () => {
    await makeAttackable("underground", a.id, t.id);
    await seedReport(a.id, t.id, { endsAt: new Date(Date.now() + 3_600_000), succeeded: null });
    expect((await attack(a.token, t.id)).json<{ error: string }>().error).toBe("no_detective_report");
  });

  it("underground, failed report: 409", async () => {
    await makeAttackable("underground", a.id, t.id);
    await seedReport(a.id, t.id, { succeeded: false });
    const res = await attack(a.token, t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_detective_report");
  });

  it("underground, expired report: 409", async () => {
    await makeAttackable("underground", a.id, t.id);
    await seedReport(a.id, t.id, { expiresAt: new Date(Date.now() - 1000) });
    const res = await attack(a.token, t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_detective_report");
  });

  it("underground, legacy NULL expires_at: 409", async () => {
    await makeAttackable("underground", a.id, t.id);
    await seedReport(a.id, t.id, { expiresAt: null });
    const res = await attack(a.token, t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_detective_report");
  });

  it("underground, live report: the shot resolves through the normal path", async () => {
    await makeAttackable("underground", a.id, t.id);
    await seedReport(a.id, t.id);
    const res = await attack(a.token, t.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hit: boolean }>()).toHaveProperty("hit");
  });

  it("underground gangmate: same_gang, not no_detective_report (check order)", async () => {
    await makeAttackable("underground", a.id, t.id);
    const gangId = uuidv7();
    await db.insert(gangs).values({ id: gangId, name: `g-${gangId.slice(-8)}`, bossPlayerId: a.id });
    await db.insert(gangMembers).values([
      { gangId, playerId: a.id },
      { gangId, playerId: t.id },
    ]);
    await db
      .update(playerStats)
      .set({ gangId })
      .where(inArray(playerStats.playerId, [a.id, t.id]));
    const res = await attack(a.token, t.id);
    expect(res.json<{ error: string }>().error).toBe("same_gang");
  });
});

describe("travel board", () => {
  it("lists combatMode on the travel board", async () => {
    await makeAttackable("underground", a.id);
    const res = await app.inject({ method: "GET", url: "/api/locations",
      headers: { authorization: `Bearer ${a.token}` } });
    const town = res.json<{ locations: { combatMode?: string; current: boolean }[] }>()
      .locations.find((l) => l.current);
    expect(town?.combatMode).toBe("underground");
  });
});

describe("combat targets route", () => {
  const targets = (token: string) =>
    app.inject({ method: "GET", url: "/api/combat/targets",
      headers: { authorization: `Bearer ${token}` } });

  it("open town: body carries mode=open and lists everyone", async () => {
    await makeAttackable("open", a.id, t.id);
    const body = (await targets(a.token)).json<{ mode: string; targets: { playerId: string }[] }>();
    expect(body.mode).toBe("open");
    expect(body.targets.map((r) => r.playerId)).toContain(t.id);
  });

  it("underground: lists only reported players, absent not reasoned", async () => {
    const bystander = await register();
    await makeAttackable("underground", a.id, t.id, bystander.id);
    await seedReport(a.id, t.id);
    const body = (await targets(a.token)).json<{ mode: string; targets: { playerId: string }[] }>();
    expect(body.mode).toBe("underground");
    expect(body.targets.map((r) => r.playerId)).toEqual([t.id]);
  });

  it("underground with no reports: empty list, mode still underground", async () => {
    await makeAttackable("underground", a.id, t.id);
    const body = (await targets(a.token)).json<{ mode: string; targets: unknown[] }>();
    expect(body.mode).toBe("underground");
    expect(body.targets).toEqual([]);
  });

  it("underground: a reported player out-ranked by 50+ others still appears (SQL-side filter)", async () => {
    // 51 bystanders with higher exp than the reported target would push the
    // target past LIMIT 50 if the filter ran after the limit.
    const bystanders = await Promise.all(Array.from({ length: 51 }, () => makeStranger()));
    await makeAttackable("underground", a.id, t.id, ...bystanders.map((b) => b.id));
    await db.update(playerStats).set({ exp: 1_000n })
      .where(eq(playerStats.playerId, t.id));
    await seedReport(a.id, t.id);
    const body = (await targets(a.token)).json<{ targets: { playerId: string }[] }>();
    expect(body.targets.map((r) => r.playerId)).toEqual([t.id]);
  });
});
