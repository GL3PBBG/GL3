import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { loadConfig } from "../src/config.js";
import {
  detectiveSearches, locations, playerStats, settings, transactions,
} from "../src/db/schema/index.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let hirerToken: string;
let hirerId: string;
let targetId: string;
let chicagoId: string;
let miamiId: string;

const hire = (token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/detectives",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

const list = (token: string) =>
  app.inject({
    method: "GET",
    url: "/api/detectives",
    headers: { authorization: `Bearer ${token}` },
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  const hirer = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Gumshoe", password: "hunter2hunter2" },
  });
  ({ token: hirerToken, playerId: hirerId } = hirer.json());

  const target = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Fugitive", password: "hunter2hunter2" },
  });
  ({ playerId: targetId } = target.json());

  chicagoId = uuidv7();
  miamiId = uuidv7();
  await db.insert(locations).values([
    { id: chicagoId, name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: miamiId, name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("POST /api/detectives — hire", () => {
  it("debits cost x detectives x hours, inserts the search row, ledgers detectives.hire", async () => {
    await db.update(playerStats).set({ cash: 10_000_000n })
      .where(eq(playerStats.playerId, hirerId));

    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 2, hours: 3 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // 125000 (default cost) x 2 x 3 = 750000
    expect(body.cash).toBe("9250000");

    const [row] = await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, body.searchId));
    expect(row).toMatchObject({ playerId: hirerId, targetPlayerId: targetId, detectives: 2 });
    // ends_at = started_at + duration(3600s) x hours(3). started_at is the DB
    // clock, ends_at the app clock — allow 5s of skew, not equality.
    // `succeeded` is NOT asserted: bootTestServer runs real workers and the
    // resolve job may have already landed.
    const spanMs = row!.endsAt.getTime() - row!.startedAt.getTime();
    expect(Math.abs(spanMs - 3 * 3600 * 1000)).toBeLessThan(5_000);

    const [ledgerRow] = await db.select().from(transactions)
      .where(eq(transactions.reason, "detectives.hire"));
    expect(ledgerRow!.amount).toBe(-750_000n);
    expect(ledgerRow!.playerId).toBe(hirerId);
  });

  it("honours a detectives.cost settings override", async () => {
    // Settings are snapshotted at boot — insert before starting a fresh server.
    await db.insert(settings).values({ key: "detectives.cost", value: "10" });
    const { app: freshApp, close } = await bootTestServer();
    try {
      await db.update(playerStats).set({ cash: 1_000n })
        .where(eq(playerStats.playerId, hirerId));
      const res = await freshApp.inject({
        method: "POST", url: "/api/detectives",
        headers: { authorization: `Bearer ${hirerToken}` },
        payload: { targetUsername: "Fugitive", detectives: 1, hours: 1 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().cash).toBe("990");
    } finally {
      await close();
    }
  });

  it("rejects a self-search with 400 cannot_search_self", async () => {
    const res = await hire(hirerToken, { targetUsername: "Gumshoe", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_search_self");
  });

  it("rejects an unknown username with 400 target_not_found", async () => {
    const res = await hire(hirerToken, { targetUsername: "Nobody", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("target_not_found");
  });

  it("rejects detectives/hours outside 1-5 at the zod boundary", async () => {
    for (const payload of [
      { targetUsername: "Fugitive", detectives: 0, hours: 1 },
      { targetUsername: "Fugitive", detectives: 6, hours: 1 },
      { targetUsername: "Fugitive", detectives: 1, hours: 0 },
      { targetUsername: "Fugitive", detectives: 1, hours: 6 },
      { targetUsername: "Fugitive", detectives: 1.5, hours: 1 },
    ]) {
      expect((await hire(hirerToken, payload)).statusCode).toBe(400);
    }
  });

  it("409s insufficient_funds leaving no row", async () => {
    await db.update(playerStats).set({ cash: 100n })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_funds");
    expect(await db.select().from(detectiveSearches)).toHaveLength(0);
    expect(await db.select().from(transactions)
      .where(eq(transactions.reason, "detectives.hire"))).toHaveLength(0);
  });

  it("is allowed from jail (V2 gated only on login)", async () => {
    await db.update(playerStats)
      .set({ cash: 10_000_000n, jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(201);
  });

  it("401s without auth", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/detectives",
      payload: { targetUsername: "Fugitive", detectives: 1, hours: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/detectives — reveal gating and live tracking", () => {
  /** Insert a search row directly so no resolve job races the assertions. */
  const insertSearch = async (over: {
    endsAt: Date; succeeded?: boolean | null; playerId?: string;
  }): Promise<string> => {
    const id = uuidv7();
    await db.insert(detectiveSearches).values({
      id,
      playerId: over.playerId ?? hirerId,
      targetPlayerId: targetId,
      detectives: 3,
      endsAt: over.endsAt,
      succeeded: over.succeeded ?? null,
    });
    return id;
  };

  it("hides `succeeded` while pending, even when the roll is already recorded", async () => {
    // The worker resolves minutes early by design (time-gated reveal, spec
    // §2): the row knows, the API must not say.
    await insertSearch({ endsAt: new Date(Date.now() + 60_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));

    const res = await list(hirerToken);
    expect(res.statusCode).toBe(200);
    const { searches } = res.json();
    expect(searches).toHaveLength(1);
    expect(searches[0].succeeded).toBeNull();
    expect(searches[0].targetLocationId).toBeNull();
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("reveals success and the target's CURRENT location after ends_at", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));

    const first = list(hirerToken);
    expect((await first).json().searches[0]).toMatchObject({
      succeeded: true, targetLocationId: chicagoId, targetLocationName: "Chicago",
    });

    // Live tracking: the target travels; the next read shows the new place.
    await db.update(playerStats).set({ locationId: miamiId })
      .where(eq(playerStats.playerId, targetId));
    const second = await list(hirerToken);
    expect(second.json().searches[0]).toMatchObject({
      targetLocationId: miamiId, targetLocationName: "Miami",
    });
  });

  it("reveals a failure after ends_at, with no location", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: false });
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(false);
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("reads a lost resolve (NULL past ends_at) as failed, never pending forever", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: null });
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(false);
  });

  it("hides the location once the report expires (ends_at + expire)", async () => {
    // Default expire is 600s; 700s past ends_at is expired.
    await insertSearch({ endsAt: new Date(Date.now() - 700_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(true);
    expect(searches[0].targetLocationId).toBeNull();
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("lists only the caller's own searches, newest first, with cost", async () => {
    const older = await insertSearch({ endsAt: new Date(Date.now() + 30_000) });
    const newer = await insertSearch({ endsAt: new Date(Date.now() + 60_000) });
    // A foreign row must not appear — silent to everyone but the hirer.
    await insertSearch({ endsAt: new Date(Date.now() + 60_000), playerId: targetId });

    const body = (await list(hirerToken)).json();
    expect(body.cost).toBe("125000");
    expect(body.searches).toHaveLength(2);
    expect(body.searches.map((s: { id: string }) => s.id)).toEqual([newer, older]);
    expect(body.searches[0].targetUsername).toBe("Fugitive");
    expect(typeof body.searches[0].startedAt).toBe("string");
    expect(typeof body.searches[0].endsAt).toBe("string");
    expect(typeof body.searches[0].expiresAt).toBe("string");
  });

  it("401s without auth", async () => {
    expect((await app.inject({ method: "GET", url: "/api/detectives" })).statusCode).toBe(401);
  });
});
