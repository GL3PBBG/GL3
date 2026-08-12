import { and, eq } from "drizzle-orm";
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  locations,
  playerStats,
  settings,
  transactions,
} from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Minimal Drizzle table definitions for plugin-owned tables — the test lives in
 * apps/server/ and cannot import from packages/plugins/ at runtime (no dist/
 * built yet, and the workspace alias resolves to source for vitest but not for
 * tsc). These mirrors match the column set the test assertions touch; they are
 * NOT used for inserts (the route handler does that).
 */
const ocHeists = pgTable("p_oc_heists", {
  id: uuid("id").primaryKey(),
  leaderId: uuid("leader_id").notNull(),
  locationId: uuid("location_id").notNull(),
  status: text("status").notNull(),
  buyIn: bigint("buy_in", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
});

const ocMembers = pgTable("p_oc_members", {
  heistId: uuid("heist_id").notNull(),
  playerId: uuid("player_id").notNull(),
  role: text("role").notNull(),
  state: text("state").notNull(),
  released: boolean("released").notNull().default(false),
});

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let leaderToken: string;
let leaderId: string;
let otherToken: string;
let otherId: string;
let locationId: string;

const inject = (method: string, url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload } : {}),
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  // Players need a location for heist creation (the route reads it from
  // player_stats). Insert one and assign it to both players.
  locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId, name: "Chicago", travelCost: 100n,
    travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n,
  });

  const leader = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Boss", password: "hunter2hunter2" },
  });
  ({ token: leaderToken, playerId: leaderId } = leader.json());
  await db.update(playerStats).set({ locationId })
    .where(eq(playerStats.playerId, leaderId));

  const other = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Crewman", password: "hunter2hunter2" },
  });
  ({ token: otherToken, playerId: otherId } = other.json());
  await db.update(playerStats).set({ locationId })
    .where(eq(playerStats.playerId, otherId));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("POST /api/oc — create heist", () => {
  it("creates a heist: 201, leader escrowed, mastermind slot accepted", async () => {
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, leaderId));
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, leaderId);

    const res = await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.heistId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.cash).toBe("5000");

    // Exactly one ledger row for oc.buyin
    const ledgerRows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, leaderId), eq(transactions.reason, "oc.buyin")));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.amount).toBe(-5000n);

    // Member row: leader is mastermind, accepted
    const [member] = await db.select().from(ocMembers)
      .where(eq(ocMembers.playerId, leaderId));
    expect(member).toMatchObject({ role: "mastermind", state: "accepted", released: false });

    // Heist row
    const [heist] = await db.select().from(ocHeists)
      .where(eq(ocHeists.id, body.heistId));
    expect(heist).toMatchObject({ status: "open", buyIn: 5000n, leaderId });

    // Event published
    const event = await waiting;
    expect(event).toMatchObject({ type: "oc.updated", heistId: body.heistId, status: "open" });
  });

  it("refuses a second active heist with 409 already_in_heist and NO ledger row", async () => {
    await db.update(playerStats).set({ cash: 100_000n })
      .where(eq(playerStats.playerId, leaderId));
    await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
    const res = await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "already_in_heist" });
    const rows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, leaderId), eq(transactions.reason, "oc.buyin")));
    expect(rows).toHaveLength(1); // only the first create's escrow — rollback ate the second's
  });

  it("refuses buyIn below oc.buy_in_min with 409 below_minimum", async () => {
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, leaderId));
    const res = await inject("POST", "/api/oc", leaderToken, { buyIn: "1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("below_minimum");
  });

  it("refuses a non-positive buyIn with 400", async () => {
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, leaderId));

    const res0 = await inject("POST", "/api/oc", leaderToken, { buyIn: "0" });
    expect(res0.statusCode).toBe(400);
    expect(res0.json().error).toBe("amount_must_be_positive");

    const resNeg = await inject("POST", "/api/oc", leaderToken, { buyIn: "-5" });
    expect(resNeg.statusCode).toBe(400);
    expect(resNeg.json().error).toBe("amount_must_be_positive");
  });

  it("refuses insufficient funds with 409 and no ledger row", async () => {
    // Player has default starting cash (very low)
    const res = await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_funds");
    const rows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, leaderId), eq(transactions.reason, "oc.buyin")));
    expect(rows).toHaveLength(0);
  });

  it("honours an oc.buy_in_min settings override", async () => {
    // Settings are snapshotted at boot — insert before starting a fresh server.
    await db.insert(settings).values({ key: "oc.buy_in_min", value: "50000" });
    const { app: freshApp, close } = await bootTestServer();
    try {
      await db.update(playerStats).set({ cash: 100_000n })
        .where(eq(playerStats.playerId, leaderId));
      const freshInject = (method: string, url: string, token: string, payload?: Record<string, unknown>) =>
        freshApp.inject({
          method: method as "GET" | "POST" | "PUT" | "DELETE",
          url,
          headers: { authorization: `Bearer ${token}` },
          ...(payload !== undefined ? { payload } : {}),
        });
      expect((await freshInject("POST", "/api/oc", leaderToken, { buyIn: "49999" })).statusCode).toBe(409);
      expect((await freshInject("POST", "/api/oc", leaderToken, { buyIn: "50000" })).statusCode).toBe(201);
    } finally {
      await close();
    }
  });
});

describe("GET /api/oc — state", () => {
  it("returns {heist: null, invites: []} for an uninvolved player", async () => {
    const res = await inject("GET", "/api/oc", otherToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.heist).toBeNull();
    expect(body.invites).toEqual([]);
  });

  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/oc" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the active heist after creation with correct member shape", async () => {
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, leaderId));
    const createRes = await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
    expect(createRes.statusCode).toBe(201);
    const { heistId } = createRes.json();

    const res = await inject("GET", "/api/oc", leaderToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.heist).not.toBeNull();
    expect(body.heist.id).toBe(heistId);
    expect(body.heist.status).toBe("open");
    expect(body.heist.buyIn).toBe("5000");
    expect(body.heist.leaderId).toBe(leaderId);
    expect(body.heist.members).toHaveLength(1);
    expect(body.heist.members[0]).toMatchObject({
      playerId: leaderId,
      role: "mastermind",
      state: "accepted",
    });
  });
});
