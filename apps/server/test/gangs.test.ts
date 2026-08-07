import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangs, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Vito", password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("POST /api/gangs", () => {
  it("creates a gang, makes the creator boss and member, and logs it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones", description: "Family business" },
    });
    expect(res.statusCode).toBe(201);
    const gang = res.json();
    expect(gang.bossPlayerId).toBe(playerId);
    expect(gang.memberCount).toBe(1);

    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.gangId).toBe(gang.id);

    const logs = await app.inject({
      method: "GET", url: `/api/gangs/${gang.id}/logs`, headers: { authorization: `Bearer ${token}` },
    });
    expect(logs.json().logs).toHaveLength(1);
  });

  it("409s a duplicate gang name", async () => {
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones" },
    });
    const other = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Sonny", password: "hunter2hunter2" },
    });
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${other.json().token}` },
      payload: { name: "The Corleones" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409s a player who is already in a gang", async () => {
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones" },
    });
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "Second Gang" },
    });
    expect(res.statusCode).toBe(409);
  });

  // Guards the fix for the check-then-act race found in review: an unlocked
  // pre-check SELECT before the transaction let two concurrent creates from
  // the same player both pass before either committed, producing two gangs
  // with one permanently orphaned. See routes.ts's AlreadyInGangError.
  it("under two concurrent creates from the same player, lets exactly one succeed and leaves exactly one gang", async () => {
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
        payload: { name: "The Corleones" },
      }),
      app.inject({
        method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
        payload: { name: "Second Gang" },
      }),
    ]);
    const statusCodes = [a.statusCode, b.statusCode].sort();
    expect(statusCodes).toEqual([201, 409]);

    const rows = await db.select({ id: gangs.id }).from(gangs).where(eq(gangs.bossPlayerId, playerId));
    expect(rows).toHaveLength(1);
  });
});

describe("GET /api/gangs/:gangId", () => {
  it("404s an unknown gang", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/gangs/018f8e2a-0000-7000-8000-0000000000ff",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
