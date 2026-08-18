import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: `Sick${Date.now()}` }));
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${token}` });

describe("POST /api/hospital/checkin", () => {
  it("409s a player at full health", async () => {
    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_injured" });
  });

  it("admits a hurt player for a stay proportional to the missing health", async () => {
    // 40 missing HP × the 30s/HP default = a 1200s stay.
    await db.update(playerStats).set({ health: 60 }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hospitalised).toBe(true);
    expect(body.remainingSeconds).toBeGreaterThan(1190);
    expect(body.remainingSeconds).toBeLessThanOrEqual(1200);
    // Health goes to 0 for the duration — the stay is the heal, not a shortcut.
    expect(body.health).toBe(0);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.health).toBe(0);
    expect(row?.hospitalUntil).not.toBeNull();
  });

  it("409s a player who is already in hospital", async () => {
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "already_hospitalised" });
  });

  it("is allowed while jailed and does not shorten the jail sentence", async () => {
    const jailedUntil = new Date(Date.now() + 600_000);
    await db.update(playerStats)
      .set({ health: 90, jailedUntil })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.jailedUntil?.getTime()).toBe(jailedUntil.getTime());
  });

  it("quotes a discharge price for the stay it just created", async () => {
    await db.update(playerStats).set({ health: 99 }).where(eq(playerStats.playerId, playerId));
    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    // 1 missing HP × 30s × the 1000/second discharge default = 30,000.
    expect(BigInt(res.json().dischargeCost)).toBeGreaterThan(29_000n);
    expect(BigInt(res.json().dischargeCost)).toBeLessThanOrEqual(30_000n);
  });
});
