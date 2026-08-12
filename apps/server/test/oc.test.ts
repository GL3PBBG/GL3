import { and, eq } from "drizzle-orm";
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  locations,
  notifications,
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

// ── helpers ──────────────────────────────────────────────────────────
/** Create an open heist as leader and return its heistId. */
async function createHeist(buyIn = "5000"): Promise<string> {
  await db.update(playerStats).set({ cash: 10_000n })
    .where(eq(playerStats.playerId, leaderId));
  const res = await inject("POST", "/api/oc", leaderToken, { buyIn });
  expect(res.statusCode).toBe(201);
  return res.json().heistId;
}

describe("POST /api/oc/:heistId/invite", () => {
  it("leader invites a player to an open role; invitee is notified and sees the invite", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "driver",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ invited: true });

    // Notification delivered
    const [note] = await db.select().from(notifications)
      .where(eq(notifications.playerId, otherId));
    expect(note.body).toContain("heist");
    expect(note.body).toContain("driver");
    expect(note.body).toContain("5000");

    // Invitee sees the invite in state
    const state = (await inject("GET", "/api/oc", otherToken)).json();
    expect(state.invites).toHaveLength(1);
    expect(state.invites[0]).toMatchObject({ heistId, role: "driver" });
  });

  it("non-leader cannot invite: 403 not_leader", async () => {
    const heistId = await createHeist();
    // otherId is not the leader — try inviting as crewman
    const res = await inject("POST", `/api/oc/${heistId}/invite`, otherToken, {
      targetUsername: "Boss", role: "driver",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_leader");
  });

  it("mastermind role cannot be invited: 409 invalid_role", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "mastermind",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_role");
  });

  it("unknown role: 409 invalid_role", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "getaway-pilot",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_role");
  });

  it("self invite: 409 self_invite", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Boss", role: "driver",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("self_invite");
  });

  it("target not found: 404 target_not_found", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "NobodyHere", role: "driver",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("target_not_found");
  });

  it("heist not found: 404 heist_not_found", async () => {
    const fakeId = uuidv7();
    const res = await inject("POST", `/api/oc/${fakeId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "driver",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("heist_not_found");
  });

  it("two invites for one seat are allowed (first-to-accept-wins is Task 7's race)", async () => {
    const heistId = await createHeist();
    // Register a third player
    const third = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "DriverB", password: "hunter2hunter2" },
    });
    const { playerId: thirdId } = third.json();
    await db.update(playerStats).set({ locationId })
      .where(eq(playerStats.playerId, thirdId));

    const res1 = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "driver",
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "DriverB", role: "driver",
    });
    expect(res2.statusCode).toBe(201);

    // Both players see an invite for "driver"
    const state1 = (await inject("GET", "/api/oc", otherToken)).json();
    const state2 = (await inject("GET", "/api/oc", third.json().token)).json();
    expect(state1.invites[0].role).toBe("driver");
    expect(state2.invites[0].role).toBe("driver");
  });

  it("inviting the same player twice to one heist: 409 already_invited", async () => {
    const heistId = await createHeist();
    const res1 = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "driver",
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "gunman",
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toBe("already_invited");
  });

  // role_taken needs an accepted non-leader row — covered by accept tests below.
  // The leader's own accepted mastermind row can't stand in: inviting for
  // mastermind hits invalid_role before the role_taken check.
});

describe("POST /api/oc/:heistId/decline", () => {
  it("decline deletes the invited row", async () => {
    const heistId = await createHeist();
    // Invite first
    const invRes = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: "Crewman", role: "driver",
    });
    expect(invRes.statusCode).toBe(201);

    // Decline
    const res = await inject("POST", `/api/oc/${heistId}/decline`, otherToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ declined: true });

    // Invite gone from state
    const state = (await inject("GET", "/api/oc", otherToken)).json();
    expect(state.invites).toEqual([]);
  });

  it("decline with no invite: 404 not_invited", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/decline`, otherToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_invited");
  });
});

// ── helpers ──────────────────────────────────────────────────────────
/** Register a player with the given username, assign shared location, return token + id. */
async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  const { token, playerId } = res.json();
  await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, playerId));
  return { token, playerId };
}

/** Register a player, fund them, invite them to a heist role. Does NOT accept. */
async function invitePlayer(
  heistId: string,
  username: string,
  role: string,
  cash = 100_000n,
): Promise<{ token: string; playerId: string }> {
  const p = await registerPlayer(username);
  await db.update(playerStats).set({ cash }).where(eq(playerStats.playerId, p.playerId));
  const inv = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
    targetUsername: username, role,
  });
  expect(inv.statusCode).toBe(201);
  return p;
}

describe("POST /api/oc/:heistId/accept", () => {
  it("accept escrows the buy-in and fills the slot", async () => {
    const heistId = await createHeist();
    const { token: driverToken, playerId: driverId } = await invitePlayer(heistId, "Driver1", "driver");

    const res = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().cash).toBeDefined();

    // Exactly one ledger row for oc.buyin
    const ledgerRows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.buyin")));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.amount).toBe(-5000n);

    // Member row flipped to accepted
    const state = (await inject("GET", "/api/oc", driverToken)).json();
    expect(state.heist.members).toContainEqual(
      expect.objectContaining({ playerId: driverId, role: "driver", state: "accepted" }),
    );
  });

  it("accept publishes oc.updated to the accepted member list", async () => {
    const heistId = await createHeist();
    const { token: driverToken, playerId: driverId } = await invitePlayer(heistId, "Driver2", "driver");
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, driverId);

    const res = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(res.statusCode).toBe(200);

    const event = await waiting;
    expect(event).toMatchObject({ type: "oc.updated", heistId, status: "open" });
  });

  it("accept clears the player's other pending invites (gang-invite precedent)", async () => {
    // Create two heists with different leaders, invite same driver to both
    const heistId1 = await createHeist();
    const leader2 = await registerPlayer("Boss2");
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, leader2.playerId));
    const heist2Res = await inject("POST", "/api/oc", leader2.token, { buyIn: "5000" });
    expect(heist2Res.statusCode).toBe(201);
    const heistId2 = heist2Res.json().heistId;

    const { token: driverToken, playerId: driverId } = await registerPlayer("ClearInviteDriver");
    await db.update(playerStats).set({ cash: 200_000n })
      .where(eq(playerStats.playerId, driverId));

    // Invite to heist1 as driver
    const inv1 = await inject("POST", `/api/oc/${heistId1}/invite`, leaderToken, {
      targetUsername: "ClearInviteDriver", role: "driver",
    });
    expect(inv1.statusCode).toBe(201);
    // Invite to heist2 as gunman
    const inv2 = await inject("POST", `/api/oc/${heistId2}/invite`, leader2.token, {
      targetUsername: "ClearInviteDriver", role: "gunman",
    });
    expect(inv2.statusCode).toBe(201);

    // Accept heist1
    const acc = await inject("POST", `/api/oc/${heistId1}/accept`, driverToken);
    expect(acc.statusCode).toBe(200);

    // The other invite (heist2, gunman) should be gone
    const state = (await inject("GET", "/api/oc", driverToken)).json();
    expect(state.invites).toEqual([]);
    // No pending rows for driverId with state invited
    const pending = await db.select().from(ocMembers).where(and(
      eq(ocMembers.playerId, driverId), eq(ocMembers.state, "invited"),
    ));
    expect(pending).toHaveLength(0);
  });

  it("accept while already in another heist: 409 already_in_heist, no second buyin row", async () => {
    const heistId1 = await createHeist();
    const { token: driverToken, playerId: driverId } = await invitePlayer(heistId1, "DoubleAccept", "driver");
    // Accept heist1
    const acc1 = await inject("POST", `/api/oc/${heistId1}/accept`, driverToken);
    expect(acc1.statusCode).toBe(200);

    // Invite to a second heist (different leader — the original leader is in heist1)
    const leader2 = await registerPlayer("Boss2");
    await db.update(playerStats).set({ cash: 10_000n })
      .where(eq(playerStats.playerId, leader2.playerId));
    const heist2Res = await inject("POST", "/api/oc", leader2.token, { buyIn: "5000" });
    expect(heist2Res.statusCode).toBe(201);
    const heistId2 = heist2Res.json().heistId;
    const inv = await inject("POST", `/api/oc/${heistId2}/invite`, leader2.token, {
      targetUsername: "DoubleAccept", role: "gunman",
    });
    expect(inv.statusCode).toBe(201);

    // Try to accept — partial unique index blocks it
    const res = await inject("POST", `/api/oc/${heistId2}/accept`, driverToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_in_heist");

    // Only one buyin row total (from heist1 accept)
    const buyinRows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.buyin")));
    expect(buyinRows).toHaveLength(1);
  });

  it("accept with insufficient funds: 409, invite row still invited, no ledger row", async () => {
    const heistId = await createHeist();
    const { token: driverToken, playerId: driverId } = await invitePlayer(heistId, "BrokeDriver", "driver", 100n);

    const res = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_funds");

    // Invite row still present as invited
    const rows = await db.select().from(ocMembers).where(and(
      eq(ocMembers.heistId, heistId), eq(ocMembers.playerId, driverId),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("invited");

    // No ledger row
    const ledgerRows = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.buyin")));
    expect(ledgerRows).toHaveLength(0);
  });

  it("not invited: 404 not_invited", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/accept`, otherToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_invited");
  });

  it("accepted role is taken: 409 role_taken", async () => {
    // Invite A as driver, A accepts. Invite B as driver, B tries to accept.
    const heistId = await createHeist();
    const pA = await invitePlayer(heistId, "DriverA", "driver");
    const pB = await invitePlayer(heistId, "DriverB", "driver");

    // A accepts
    const accA = await inject("POST", `/api/oc/${heistId}/accept`, pA.token);
    expect(accA.statusCode).toBe(200);

    // B tries to accept — seat taken
    const accB = await inject("POST", `/api/oc/${heistId}/accept`, pB.token);
    expect(accB.statusCode).toBe(409);
    expect(accB.json().error).toBe("role_taken");
  });

  it("heist not found: 404 heist_not_found", async () => {
    const fakeId = uuidv7();
    const res = await inject("POST", `/api/oc/${fakeId}/accept`, otherToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("heist_not_found");
  });

  it("heist not open: 409 heist_not_open", async () => {
    const heistId = await createHeist();
    await db.update(ocHeists).set({ status: "cancelled" }).where(eq(ocHeists.id, heistId));

    const { token: driverToken, playerId: driverId } = await registerPlayer("ClosedHeistDriver");
    await db.update(playerStats).set({ cash: 100_000n })
      .where(eq(playerStats.playerId, driverId));
    // Insert an invited row directly for the test
    await db.insert(ocMembers).values({
      heistId, playerId: driverId, role: "driver", state: "invited",
    });

    const res = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("heist_not_open");
  });
});

describe("POST /api/oc/:heistId/leave", () => {
  it("leave refunds and frees the slot", async () => {
    const heistId = await createHeist();
    const { token: driverToken, playerId: driverId } = await invitePlayer(heistId, "LeaveDriver", "driver");
    // Accept first
    const acc = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(acc.statusCode).toBe(200);

    const res = await inject("POST", `/api/oc/${heistId}/leave`, driverToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().cash).toBeDefined();

    // One refund row
    const refunds = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.refund")));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount).toBe(5000n);

    // Member row deleted
    const rows = await db.select().from(ocMembers).where(and(
      eq(ocMembers.heistId, heistId), eq(ocMembers.playerId, driverId),
    ));
    expect(rows).toHaveLength(0);

    // No longer appears in heist state
    const state = (await inject("GET", "/api/oc", driverToken)).json();
    expect(state.heist).toBeNull();
  });

  it("leader cannot leave: 403 leader_cannot_leave", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/leave`, leaderToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("leader_cannot_leave");
  });

  it("not a member: 404 not_member", async () => {
    const heistId = await createHeist();
    const res = await inject("POST", `/api/oc/${heistId}/leave`, otherToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_member");
  });

  it("heist not open: 409 heist_not_open", async () => {
    const heistId = await createHeist();
    const { token: driverToken } = await invitePlayer(heistId, "LeaveClosedDriver", "driver");
    const acc = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(acc.statusCode).toBe(200);
    // Cancel the heist via DB
    await db.update(ocHeists).set({ status: "cancelled" }).where(eq(ocHeists.id, heistId));

    const res = await inject("POST", `/api/oc/${heistId}/leave`, driverToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("heist_not_open");
  });
});

describe("POST /api/oc/:heistId/cancel", () => {
  it("cancels and refunds every accepted member; invited-only members get nothing", async () => {
    const heistId = await createHeist();
    // Accept driver
    const { token: driverToken, playerId: driverId } = await invitePlayer(heistId, "CancelDriver", "driver");
    const accD = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(accD.statusCode).toBe(200);
    // Invite gunman but do NOT accept
    const gunman = await invitePlayer(heistId, "CancelGunman", "gunman");

    const res = await inject("POST", `/api/oc/${heistId}/cancel`, leaderToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cancelled: true });

    // Leader has one oc.refund
    const leaderRefunds = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, leaderId), eq(transactions.reason, "oc.refund")));
    expect(leaderRefunds).toHaveLength(1);
    expect(leaderRefunds[0]!.amount).toBe(5000n);

    // Driver has one oc.refund
    const driverRefunds = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.refund")));
    expect(driverRefunds).toHaveLength(1);
    expect(driverRefunds[0]!.amount).toBe(5000n);

    // Gunman has NO refund (was only invited)
    const gunmanRefunds = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, gunman.playerId), eq(transactions.reason, "oc.refund")));
    expect(gunmanRefunds).toHaveLength(0);

    // Heist status cancelled
    const [heist] = await db.select().from(ocHeists).where(eq(ocHeists.id, heistId));
    expect(heist!.status).toBe("cancelled");

    // All member rows released
    const members = await db.select().from(ocMembers).where(eq(ocMembers.heistId, heistId));
    for (const m of members) expect(m.released).toBe(true);
  });

  it("after cancel, a former member can create their own heist", async () => {
    const heistId = await createHeist();
    const { token: driverToken, playerId: driverId } = await invitePlayer(heistId, "ReuseDriver", "driver");
    const acc = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(acc.statusCode).toBe(200);

    // Cancel
    const cancel = await inject("POST", `/api/oc/${heistId}/cancel`, leaderToken);
    expect(cancel.statusCode).toBe(200);

    // Former driver can now create their own heist (partial index released)
    await db.update(playerStats).set({ cash: 100_000n })
      .where(eq(playerStats.playerId, driverId));
    const create = await inject("POST", "/api/oc", driverToken, { buyIn: "5000" });
    expect(create.statusCode).toBe(201);
    expect(create.json().heistId).toBeDefined();
  });

  it("non-leader cannot cancel: 403 not_leader", async () => {
    const heistId = await createHeist();
    const { token: driverToken } = await invitePlayer(heistId, "NotLeaderDriver", "driver");
    const acc = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
    expect(acc.statusCode).toBe(200);

    const res = await inject("POST", `/api/oc/${heistId}/cancel`, driverToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_leader");
  });

  it("heist not found: 404 heist_not_found", async () => {
    const fakeId = uuidv7();
    const res = await inject("POST", `/api/oc/${fakeId}/cancel`, leaderToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("heist_not_found");
  });

  it("heist not open: 409 heist_not_open", async () => {
    const heistId = await createHeist();
    // Cancel it once
    const cancel1 = await inject("POST", `/api/oc/${heistId}/cancel`, leaderToken);
    expect(cancel1.statusCode).toBe(200);

    // Try again
    const cancel2 = await inject("POST", `/api/oc/${heistId}/cancel`, leaderToken);
    expect(cancel2.statusCode).toBe(409);
    expect(cancel2.json().error).toBe("heist_not_open");
  });
});

describe("POST /api/oc/:heistId/execute", () => {
  /** Build a full 4-member crew ready to execute, returns heistId + player infos. */
  async function buildFullCrew(buyIn = "5000") {
    const heistId = await createHeist(buyIn);
    const driver = await invitePlayer(heistId, "ExecDriver", "driver");
    await inject("POST", `/api/oc/${heistId}/accept`, driver.token);
    const gunman = await invitePlayer(heistId, "ExecGunman", "gunman");
    await inject("POST", `/api/oc/${heistId}/accept`, gunman.token);
    const hacker = await invitePlayer(heistId, "ExecHacker", "hacker");
    await inject("POST", `/api/oc/${heistId}/accept`, hacker.token);
    return { heistId, driver, gunman, hacker };
  }

  it("execute with a full, co-located crew: 202 with a jobId; status becomes executing", async () => {
    const { heistId } = await buildFullCrew();
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, leaderId);

    const res = await inject("POST", `/api/oc/${heistId}/execute`, leaderToken);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.jobId).toBeDefined();

    const [heist] = await db.select().from(ocHeists).where(eq(ocHeists.id, heistId));
    expect(heist!.status).toBe("executing");

    const event = await waiting;
    expect(event).toMatchObject({ type: "oc.updated", heistId, status: "executing" });
  });

  it("execute with an unfilled slot: 409 crew_incomplete", async () => {
    const heistId = await createHeist();
    const driver = await invitePlayer(heistId, "IncDriver", "driver");
    await inject("POST", `/api/oc/${heistId}/accept`, driver.token);

    const res = await inject("POST", `/api/oc/${heistId}/execute`, leaderToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("crew_incomplete");
  });

  it("execute with a member elsewhere: 409 crew_not_assembled naming them", async () => {
    const { heistId, gunman } = await buildFullCrew();

    const otherLocationId = uuidv7();
    await db.insert(locations).values({
      id: otherLocationId, name: "NewYork", travelCost: 200n,
      travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n,
    });
    await db.update(playerStats).set({ locationId: otherLocationId })
      .where(eq(playerStats.playerId, gunman.playerId));

    const res = await inject("POST", `/api/oc/${heistId}/execute`, leaderToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("crew_not_assembled");
    expect(res.json().absent).toContain("ExecGunman");
  });

  it("non-leader cannot execute: 403 not_leader", async () => {
    const heistId = await createHeist();
    const driver = await invitePlayer(heistId, "NotLeaderDriver", "driver");
    await inject("POST", `/api/oc/${heistId}/accept`, driver.token);

    const res = await inject("POST", `/api/oc/${heistId}/execute`, driver.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_leader");
  });
});
