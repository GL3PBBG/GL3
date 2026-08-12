import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  bounties,
  gangMembers,
  gangs,
  playerStats,
  settings,
  transactions,
} from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let placerToken: string;
let placerId: string;
let targetId: string;

const place = (token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/bounties",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  const placer = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Placer", password: "hunter2hunter2" },
  });
  ({ token: placerToken, playerId: placerId } = placer.json());

  const target = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Marked", password: "hunter2hunter2" },
  });
  ({ playerId: targetId } = target.json());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("POST /api/bounties — placement", () => {
  it("escrows the amount, inserts an open row, and publishes bounty.placed", async () => {
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, placerId));
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, placerId);

    const res = await place(placerToken, { targetUsername: "Marked", amount: "5000" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cash).toBe("5000");

    const [row] = await db.select().from(bounties).where(eq(bounties.id, body.bountyId));
    expect(row).toMatchObject({ placedBy: placerId, target: targetId, amount: 5000n, claimedBy: null });

    const [ledgerRow] = await db.select().from(transactions)
      .where(eq(transactions.reason, "bounties.placed"));
    expect(ledgerRow.amount).toBe(-5000n);

    const event = await waiting;
    expect(event).toMatchObject({ type: "bounty.placed", targetId, amount: "5000" });
  });

  it("rejects below bounties.minAmount default 1000", async () => {
    const res = await place(placerToken, { targetUsername: "Marked", amount: "999" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("below_minimum");
  });

  it("honours a bounties.minAmount settings override", async () => {
    // Settings are snapshotted at boot — insert before starting a fresh server.
    await db.insert(settings).values({ key: "bounties.minAmount", value: "50000" });
    const { app: freshApp, close } = await bootTestServer();
    try {
      await db.update(playerStats).set({ cash: 100_000n })
        .where(eq(playerStats.playerId, placerId));
      const inject = (body: Record<string, unknown>) =>
        freshApp.inject({
          method: "POST", url: "/api/bounties",
          headers: { authorization: `Bearer ${placerToken}` },
          payload: body,
        });
      expect((await inject({ targetUsername: "Marked", amount: "49999" })).statusCode).toBe(409);
      expect((await inject({ targetUsername: "Marked", amount: "50000" })).statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  it("rejects a self-bounty", async () => {
    const res = await place(placerToken, { targetUsername: "Placer", amount: "5000" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("self_bounty");
  });

  it("404s an unknown username", async () => {
    const res = await place(placerToken, { targetUsername: "Nobody", amount: "5000" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("target_not_found");
  });

  it("rejects a bounty on a gang mate", async () => {
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, placerId));
    const gangId = crypto.randomUUID();
    await db.insert(gangs).values({ id: gangId, name: `g-${gangId.slice(-8)}`, bossPlayerId: placerId });
    await db.insert(gangMembers).values([
      { gangId, playerId: placerId },
      { gangId, playerId: targetId },
    ]);
    // The route reads gangId from playerStats, not gangMembers — match reality.
    await db.update(playerStats).set({ gangId })
      .where(inArray(playerStats.playerId, [placerId, targetId]));
    const res = await place(placerToken, { targetUsername: "Marked", amount: "5000" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("same_gang");
  });

  it("rejects when the placer cannot afford it, leaving no row", async () => {
    await db.update(playerStats).set({ cash: 100n })
      .where(eq(playerStats.playerId, placerId));
    const res = await place(placerToken, { targetUsername: "Marked", amount: "5000" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_funds");
    expect(await db.select().from(bounties)).toHaveLength(0);
  });
});

describe("GET /api/bounties — open list", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bounties" });
    expect(res.statusCode).toBe(401);
  });

  it("lists open bounties newest-first with names, and hides claimed rows", async () => {
    await db.insert(bounties).values([
      { id: uuidv7(), placedBy: placerId, target: targetId, amount: 1000n },
      { id: uuidv7(), placedBy: placerId, target: targetId, amount: 2000n },
      { id: uuidv7(), placedBy: placerId, target: targetId, amount: 3000n, claimedBy: placerId },
    ]);
    const res = await app.inject({
      method: "GET", url: "/api/bounties",
      headers: { authorization: `Bearer ${placerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { bounties: rows } = res.json();
    expect(rows).toHaveLength(2); // claimed row hidden
    expect(rows[0]).toMatchObject({
      targetId, targetUsername: "Marked", placerUsername: "Placer", amount: "2000",
    });
    expect(rows.map((r: { amount: string }) => r.amount)).toEqual(["2000", "1000"]);
  });

  it("returns targetRank null when the target has no rank", async () => {
    await db.insert(bounties).values([
      { id: uuidv7(), placedBy: placerId, target: targetId, amount: 5000n },
    ]);
    const res = await app.inject({
      method: "GET", url: "/api/bounties",
      headers: { authorization: `Bearer ${placerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { bounties: rows } = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetRank).toBeNull();
  });

  it("returns createdAt as an ISO string and amount as a decimal string", async () => {
    await db.insert(bounties).values([
      { id: uuidv7(), placedBy: placerId, target: targetId, amount: 7500n },
    ]);
    const res = await app.inject({
      method: "GET", url: "/api/bounties",
      headers: { authorization: `Bearer ${placerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { bounties: rows } = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("7500");
    expect(typeof rows[0].createdAt).toBe("string");
    expect(() => new Date(rows[0].createdAt)).not.toThrow();
  });
});
