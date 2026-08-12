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
