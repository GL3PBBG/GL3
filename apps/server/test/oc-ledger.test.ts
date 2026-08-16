/**
 * OC ledger reconciliation — proves sum(ledger) == balance for every crew member
 * across all three outcomes (success, failure, cancel).
 *
 * This file seeds starting cash THROUGH THE LEDGER (applyBalanceChange with
 * reason "test.seed"), NOT a bare db.update(playerStats).set({ cash }). Both
 * existing OC test files use the bare UPDATE and that breaks sum(ledger)==balance
 * by setup — they don't assert it so it doesn't matter there. This file asserts
 * it, so it MUST seed through the ledger.
 *
 * Precedent: hospital.test.ts lines 64-97 — a dedicated file that seeds
 * through the ledger specifically because it then asserts sum(ledger) == balance.
 * This file follows the same shape for the same reason.
 *
 * Does NOT edit economy-invariant.test.ts (plan is explicit). This is a
 * dedicated file because economy-invariant's synchronous callPluginRoute sweep
 * cannot drive an async BullMQ job (the resolve step).
 *
 * Structure: one booted server, three it blocks (Option A from brief).
 * Exercises the real routes (create escrow, accept escrow, cancel/resolve
 * payouts) — which is what the invariant must hold across.
 */

import { and, eq } from "drizzle-orm";
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { loadConfig } from "../src/config.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { createRedis } from "../src/redis.js";
import ocPlugin from "@gl3/plugin-oc";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Mirror table definitions for plugin-owned tables — same pattern as oc.test.ts.
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

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let leaderToken: string;
let leaderId: string;
const memberIds: string[] = [];
const memberTokens: string[] = [];

const SEED_CASH = 500_000n;
const BUY_IN = 1000n;
const MULTIPLIER = 3n;
const CREW_SIZE = 4;

const inject = (method: string, url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload } : {}),
  });

/**
 * Assert sum(ledger.cash) == player_stats.cash for a single player.
 *
 * Because cash is seeded through the ledger here (not a raw UPDATE), there is
 * no STARTING_CASH base to add — sum of every cash ledger row including the
 * test.seed credit equals cash. Contrast economy-invariant.test.ts's
 * STARTING_CASH + ledgerSum, which exists precisely because that file seeds
 * with a raw UPDATE.
 */
async function assertReconciled(playerId: string): Promise<void> {
  const [row] = await db.select({ cash: playerStats.cash })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!row) throw new Error(`missing player_stats for ${playerId}`);

  const ledgerRows = await db.select({ amount: transactions.amount, kind: transactions.balanceKind })
    .from(transactions)
    .where(and(eq(transactions.playerId, playerId), eq(transactions.balanceKind, "cash")));
  const sum = ledgerRows.reduce((acc, t) => acc + t.amount, 0n);
  expect(sum, `sum(ledger.cash) for ${playerId}`).toBe(row.cash);
}

/** Seed one player's starting cash THROUGH THE LEDGER (not bare UPDATE). */
async function seedCash(playerId: string): Promise<void> {
  await db.transaction((tx) =>
    applyBalanceChange(tx, { playerId, amount: SEED_CASH, kind: "cash", reason: "test.seed" }),
  );
}

/** Register a player, assign shared location, seed cash through ledger. */
async function registerAndSeed(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  const { token, playerId } = res.json();
  // The server's register route puts the player at the default location.
  // All members must be co-located for execute; the default works.
  await seedCash(playerId);
  return { token, playerId };
}

/** Build a full 4-member open heist with all buy-ins escrowed. Returns heistId. */
async function buildFullCrew(): Promise<string> {
  // Leader creates heist (escrows leader's buyIn via oc.buyin)
  const createRes = await inject("POST", "/api/oc", leaderToken, { buyIn: String(BUY_IN) });
  expect(createRes.statusCode).toBe(201);
  const heistId = createRes.json().heistId;

  const roles = ["driver", "gunman", "hacker"];
  for (let i = 0; i < 3; i++) {
    // Invite crew member
    const inviteRes = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken, {
      targetUsername: `LedgerCrew${testCounter}-${i}`, role: roles[i]!,
    });
    expect(inviteRes.statusCode).toBe(201);

    // Crew member accepts (escrows their buyIn via oc.buyin)
    // memberTokens[0] is the leader; crew are at indices 1, 2, 3
    const acceptRes = await inject("POST", `/api/oc/${heistId}/accept`, memberTokens[i + 1]!);
    expect(acceptRes.statusCode).toBe(200);
  }

  return heistId;
}

beforeAll(async () => {
  const booted = await bootTestServer();
  app = booted.app;
  closeServer = booted.close;

  // `POST /api/oc/:id/execute` enqueues a REAL `resolve` job onto the live
  // plugin worker bootTestServer starts, while every test below ALSO drives
  // `resolve` manually through runPluginJob with a pinned seed and pinned
  // settings (`oc.success_chance`). Both resolvers read the heist row and
  // no-op unless status is still "executing" (oc/src/index.ts), so whichever
  // commits first wins and the other silently does nothing — the manual run's
  // pinned outcome is then not the outcome under test. Under load the live
  // worker won the race and paid out `oc.payout` rows the chance-0 failure
  // test asserts are absent. Pausing the queue means the enqueue still
  // happens (the route's behaviour is unchanged) but no worker ever picks the
  // job up, so the manual run is the only resolver. The queue prefix is
  // random per boot, so this pause is invisible to every other test file.
  const resolveQueue = booted.plugins.queues.get("oc:resolve");
  if (!resolveQueue) throw new Error("oc:resolve queue not found — did the oc plugin's job name change?");
  await resolveQueue.pause();
});

let locationId: string;
let testCounter = 0;

beforeEach(async () => {
  await resetDb(db);
  memberIds.length = 0;
  memberTokens.length = 0;
  testCounter++;

  // Insert a shared location for all members (resetDb truncates locations)
  locationId = (await db.insert(locations).values({
    id: crypto.randomUUID(), name: "Chicago", travelCost: 100n,
    travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n,
  }).returning({ id: locations.id }))[0]!.id;

  // Register and seed 4 players through the ledger with stable usernames
  const leader = await registerAndSeed(`LedgerBoss${testCounter}`);
  leaderToken = leader.token;
  leaderId = leader.playerId;
  memberIds.push(leaderId);
  memberTokens.push(leaderToken);

  for (let i = 0; i < 3; i++) {
    const m = await registerAndSeed(`LedgerCrew${testCounter}-${i}`);
    memberIds.push(m.playerId);
    memberTokens.push(m.token);
  }

  // All members must be at the shared location for execute
  for (const pid of memberIds) {
    await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, pid));
  }
});

afterEach(async () => {
  // Clean up cooldown keys set during the test (success/failure resolve
  // sets per-member oc cooldowns post-commit). Targeted deletes only.
  for (const id of memberIds) {
    try { await redis.del(cooldownKey(id, "oc")); } catch { /* ignore */ }
  }
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("oc ledger reconciliation", () => {
  it("success: sum(ledger) == balance for all 4 members; net +2000 each", async () => {
    const heistId = await buildFullCrew();

    // Execute the heist (sets status "executing", enqueues resolve job)
    const execRes = await inject("POST", `/api/oc/${heistId}/execute`, leaderToken);
    expect(execRes.statusCode).toBe(202);

    // Drive the resolve job directly (runPluginJob, like oc-worker.test.ts)
    await runPluginJob(
      { db, redis, queues: new Map(), settings: { "oc.success_chance": "1" }, leaderboardPrefix: "oc-ledger-test" },
      ocPlugin,
      "resolve",
      { id: "oc-ledger-success", data: { heistId, seed: "ledger-success-seed" } },
    );

    // pot = buyIn * 4 = 4000, total = 4000 * 3 = 12000, share = 3000 each
    const pot = BUY_IN * BigInt(CREW_SIZE);
    const total = pot * MULTIPLIER;
    const share = total / BigInt(CREW_SIZE);

    for (const pid of memberIds) {
      // Ledger shape: one oc.buyin (-1000), one oc.payout (+3000)
      const buyins = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.buyin")));
      expect(buyins).toHaveLength(1);
      expect(buyins[0]!.amount).toBe(-BUY_IN);

      const payouts = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(payouts).toHaveLength(1);
      expect(payouts[0]!.amount).toBe(share);

      // No refund rows
      const refunds = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.refund")));
      expect(refunds).toHaveLength(0);

      // Net: -1000 (buyin) + 3000 (payout) = +2000
      const [row] = await db.select({ cash: playerStats.cash })
        .from(playerStats).where(eq(playerStats.playerId, pid));
      expect(row!.cash).toBe(SEED_CASH + 2000n);

      // THE assertion: sum(ledger) == balance
      await assertReconciled(pid);
    }
  });

  it("failure: sum(ledger) == balance for all 4 members; net -1000 each, all jailed", async () => {
    const heistId = await buildFullCrew();

    const execRes = await inject("POST", `/api/oc/${heistId}/execute`, leaderToken);
    expect(execRes.statusCode).toBe(202);

    await runPluginJob(
      { db, redis, queues: new Map(), settings: { "oc.success_chance": "0" }, leaderboardPrefix: "oc-ledger-test" },
      ocPlugin,
      "resolve",
      { id: "oc-ledger-failure", data: { heistId, seed: "ledger-failure-seed" } },
    );

    for (const pid of memberIds) {
      // Ledger shape: one oc.buyin (-1000), zero oc.payout, zero oc.refund
      const buyins = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.buyin")));
      expect(buyins).toHaveLength(1);
      expect(buyins[0]!.amount).toBe(-BUY_IN);

      const payouts = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(payouts).toHaveLength(0);

      const refunds = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.refund")));
      expect(refunds).toHaveLength(0);

      // Net: -1000 (buyin lost)
      const [row] = await db.select({ cash: playerStats.cash, jailedUntil: playerStats.jailedUntil })
        .from(playerStats).where(eq(playerStats.playerId, pid));
      expect(row!.cash).toBe(SEED_CASH - BUY_IN);

      // All four jailed
      expect(row!.jailedUntil).not.toBeNull();
      expect(row!.jailedUntil!.getTime()).toBeGreaterThan(Date.now());

      // THE assertion: sum(ledger) == balance
      await assertReconciled(pid);
    }
  });

  it("cancel: sum(ledger) == balance for all 4 members; net 0 each, all released", async () => {
    const heistId = await buildFullCrew();

    // Cancel (HTTP, leader only)
    const cancelRes = await inject("POST", `/api/oc/${heistId}/cancel`, leaderToken);
    expect(cancelRes.statusCode).toBe(200);

    for (const pid of memberIds) {
      // Ledger shape: one oc.buyin (-1000), one oc.refund (+1000), zero oc.payout
      const buyins = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.buyin")));
      expect(buyins).toHaveLength(1);
      expect(buyins[0]!.amount).toBe(-BUY_IN);

      const refunds = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.refund")));
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.amount).toBe(BUY_IN);

      const payouts = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(payouts).toHaveLength(0);

      // Net: -1000 (buyin) + 1000 (refund) = 0
      const [row] = await db.select({ cash: playerStats.cash })
        .from(playerStats).where(eq(playerStats.playerId, pid));
      expect(row!.cash).toBe(SEED_CASH);

      // THE assertion: sum(ledger) == balance
      await assertReconciled(pid);
    }

    // All member rows released
    const members = await db.select().from(ocMembers).where(eq(ocMembers.heistId, heistId));
    for (const m of members) expect(m.released).toBe(true);

    // Heist status cancelled
    const [heist] = await db.select().from(ocHeists).where(eq(ocHeists.id, heistId));
    expect(heist!.status).toBe("cancelled");
  });
});
