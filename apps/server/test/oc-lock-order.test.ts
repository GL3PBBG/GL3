import { and, eq, inArray } from "drizzle-orm";
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  locations,
  playerStats,
  transactions,
} from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Regression test for the heist-first lock order that execute and leave share.
 *
 * Both routes lock the heist row FOR UPDATE FIRST (via `lockHeist`), then
 * proceed to player locks. That means they serialise on the heist row —
 * whichever gets it first runs to completion; the second re-reads heist state
 * and takes the losing branch. No ABBA cycle can form because both participants
 * agree on the first lock.
 *
 * The forced interleaving: transaction A = the real execute path; transaction B
 * = the real leave path for a member. Both lock the heist row FIRST, so the
 * barrier holds that single row and both requests park before either proceeds.
 *
 * WHY A BARRIER RATHER THAN A LOOP OF `Promise.all` ROUNDS.
 * Firing both requests together and hoping they interleave is a coin flip per
 * round: they complete in microseconds and both would likely grab the heist
 * row before the other even starts. The blocker connection holds the heist
 * row so both requests are provably in flight before either can proceed, then
 * releases them from the same instant. That makes the red deterministic
 * instead of probabilistic — which matters because CLAUDE.md's corollary to
 * rule 6 is that a concurrency test nobody has seen fail proves nothing.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep.
 *
 * RED proof: temporarily invert the leave route to lock the player row BEFORE
 * the heist row — insert `await tx.locks.player([player.id]);` ABOVE the
 * lockHeist call. Now: execute holds heist → wants all player rows; leave
 * holds one player row → wants heist. That is a cycle → 40P01 → HTTP 500.
 */

/** pgTable mirrors — test lives in apps/server/ and cannot import plugin package */
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
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let locationId: string;

let leaderToken: string, leaderId: string;
let driverToken: string, driverId: string;
let gunmanToken: string, gunmanId: string;
let hackerToken: string, hackerId: string;

function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  // app.inject() is lazy — it dispatches only when something calls .then.
  // Promise.resolve schedules that immediately, which is what puts the
  // request genuinely in flight while this test waits on lock state.
  return Promise.resolve(app.inject(opts));
}

async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `;
    const seen = row?.n ?? 0;
    if (seen >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

async function register(username: string): Promise<{ token: string; playerId: string }> {
  return registerVerifiedPlayer({ app, redis }, { username });
}

const allIds = () => [leaderId, driverId, gunmanId, hackerId];

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: "Chicago",
    travelCost: 100n,
    travelCooldownSeconds: 60,
    bulletStock: 500,
    bulletCost: 5n,
  });

  ({ token: leaderToken, playerId: leaderId } = await register("BossLO"));
  ({ token: driverToken, playerId: driverId } = await register("DriverLO"));
  ({ token: gunmanToken, playerId: gunmanId } = await register("GunmanLO"));
  ({ token: hackerToken, playerId: hackerId } = await register("HackerLO"));

  await db.update(playerStats)
    .set({ locationId, cash: 100_000n, gangId: null, jailedUntil: null, hospitalUntil: null })
    .where(inArray(playerStats.playerId, allIds()));
});

afterAll(async () => {
  for (const id of allIds()) {
    await redis.del(cooldownKey(id, "oc"));
  }
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("OC lock ordering", () => {
  it("survives execute and leave released from the same barrier (heist-first order)", async () => {
    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      // Set up a full accepted crew heist first, then use the barrier
      const createRes = await app.inject({
        method: "POST",
        url: "/api/oc",
        headers: { authorization: `Bearer ${leaderToken}` },
        payload: { buyIn: "1000" },
      });
      expect(createRes.statusCode).toBe(201);
      const { heistId } = createRes.json();

      // Full accepted crew: leader=mastermind (accepted via create) + 3 roles.
      // Hacker is the leaver in the barrier race below.
      const crew = [
        { username: "DriverLO", role: "driver", token: driverToken },
        { username: "GunmanLO", role: "gunman", token: gunmanToken },
        { username: "HackerLO", role: "hacker", token: hackerToken },
      ];
      for (const c of crew) {
        const inv = await app.inject({
          method: "POST",
          url: `/api/oc/${heistId}/invite`,
          headers: { authorization: `Bearer ${leaderToken}` },
          payload: { targetUsername: c.username, role: c.role },
        });
        expect(inv.statusCode, `invite ${c.username}: ${inv.body}`).toBe(201);
      }
      for (const c of crew) {
        const acc = await app.inject({
          method: "POST",
          url: `/api/oc/${heistId}/accept`,
          headers: { authorization: `Bearer ${c.token}` },
        });
        expect(acc.statusCode, `accept ${c.username}: ${acc.body}`).toBe(200);
      }

      // Hold the heist row — the OC lock root both paths take first.
      await t0`BEGIN`;
      await t0`SELECT id FROM p_oc_heists WHERE id = ${heistId}::uuid FOR UPDATE`;

      const ex = fire({ method: "POST", url: `/api/oc/${heistId}/execute`, headers: { authorization: `Bearer ${leaderToken}` } });
      const lv = fire({ method: "POST", url: `/api/oc/${heistId}/leave`, headers: { authorization: `Bearer ${hackerToken}` } });
      inFlight.push(ex, lv);
      await waitForLockWaiters(2);
      await t0`ROLLBACK`; // release together from the same instant

      const [exRes, lvRes] = await Promise.all([ex, lv]);
      expect(exRes.statusCode, `execute body: ${exRes.body}`).not.toBe(500);
      expect(lvRes.statusCode, `leave body: ${lvRes.body}`).not.toBe(500);
      // Exactly one wins, same legal outcomes as the concurrency test
      const executed = exRes.statusCode === 202;
      const left = lvRes.statusCode === 200;
      expect(executed !== left).toBe(true);

      // If leave won, the refund was issued; if execute won, no refund.
      const refunds = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, hackerId), eq(transactions.reason, "oc.refund")));
      expect(refunds).toHaveLength(left ? 1 : 0);
    } finally {
      try { await t0`ROLLBACK`; } catch { /* already rolled back */ }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});
