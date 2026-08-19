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
 * OC concurrency: slot race (two accepts, one seat) and execute-vs-leave
 * mutual exclusion.
 *
 * Both tests are plain Promise.all races — no barrier. The heist row lock in
 * the accept, execute, and leave routes serialises concurrent requests, and
 * the correctness comes from that serialisation. The 20-iteration loop in
 * Test B proves both interleavings are reachable (the heist lock does not
 * impose a fixed winner) AND that exactly one wins every time (the lock
 * serialises).
 *
 * The RED proof for Test A requires temporarily removing lockHeist from the
 * accept route — see task-7-brief.md for the exact edit.
 *
 * The RED proof for Test B is the loop itself — if both could succeed
 * simultaneously, `executed !== left` would fail. Additionally, both
 * interleavings must be observed across 20 runs, confirming the race is
 * genuinely exercised.
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
let driverAToken: string, driverAId: string;
let driverBToken: string, driverBId: string;
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

const allIds = () => [leaderId, driverAId, driverBId, gunmanId, hackerId];

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

  ({ token: leaderToken, playerId: leaderId } = await register("Boss"));
  ({ token: driverAToken, playerId: driverAId } = await register("DriverA"));
  ({ token: driverBToken, playerId: driverBId } = await register("DriverB"));
  ({ token: gunmanToken, playerId: gunmanId } = await register("Gunman"));
  ({ token: hackerToken, playerId: hackerId } = await register("Hacker"));

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

describe("OC concurrency", () => {
  it("two accepts race one seat: exactly one 200, one 409 role_taken, one accepted row", async () => {
    // Leader creates heist
    const createRes = await app.inject({
      method: "POST",
      url: "/api/oc",
      headers: { authorization: `Bearer ${leaderToken}` },
      payload: { buyIn: "1000" },
    });
    expect(createRes.statusCode).toBe(201);
    const { heistId } = createRes.json();

    // Invite both drivers to the same "driver" role — overlapping invites allowed by design
    const invARes = await app.inject({
      method: "POST",
      url: `/api/oc/${heistId}/invite`,
      headers: { authorization: `Bearer ${leaderToken}` },
      payload: { targetUsername: "DriverA", role: "driver" },
    });
    expect(invARes.statusCode).toBe(201);

    const invBRes = await app.inject({
      method: "POST",
      url: `/api/oc/${heistId}/invite`,
      headers: { authorization: `Bearer ${leaderToken}` },
      payload: { targetUsername: "DriverB", role: "driver" },
    });
    expect(invBRes.statusCode).toBe(201);

    // Race both accepts
    const [a, b] = await Promise.all([
      fire({ method: "POST", url: `/api/oc/${heistId}/accept`, headers: { authorization: `Bearer ${driverAToken}` } }),
      fire({ method: "POST", url: `/api/oc/${heistId}/accept`, headers: { authorization: `Bearer ${driverBToken}` } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);

    // The 409 is specifically role_taken, not some other 409
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe("role_taken");

    // Exactly one accepted driver row
    const accepted = await db.select().from(ocMembers).where(and(
      eq(ocMembers.heistId, heistId),
      eq(ocMembers.role, "driver"),
      eq(ocMembers.state, "accepted"),
    ));
    expect(accepted).toHaveLength(1);

    // Loser has NO oc.buyin ledger row (debit rolled back with role_taken)
    const loserId = a.statusCode === 409 ? driverAId : driverBId;
    const buyins = await db.select().from(transactions)
      .where(and(eq(transactions.playerId, loserId), eq(transactions.reason, "oc.buyin")));
    expect(buyins).toHaveLength(0);

    // Cancel heist to release leader membership for Test B
    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/oc/${heistId}/cancel`,
      headers: { authorization: `Bearer ${leaderToken}` },
    });
    expect(cancelRes.statusCode).toBe(200);
  }, 30_000);

  it("execute racing leave: never both a payout-eligible crew and a refund", async () => {
    const crewIds = [leaderId, driverAId, gunmanId, hackerId];
    let totalRefunds = 0;
    const interleavings: Array<{ round: number; ex: number; lv: number; executed: boolean; left: boolean }> = [];

    for (let i = 0; i < 20; i++) {
      // Wait for any previous resolve job to finish (poll heist status)
      if (i > 0) {
        for (let poll = 0; poll < 50; poll++) {
          const executing = await db.select({ id: ocHeists.id })
            .from(ocHeists)
            .where(eq(ocHeists.status, "executing"));
          if (executing.length === 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // Clear cooldowns, jail/hospital, and release any active memberships
      for (const id of crewIds) {
        await redis.del(cooldownKey(id, "oc"));
      }
      await db.update(playerStats)
        .set({ jailedUntil: null, hospitalUntil: null })
        .where(inArray(playerStats.playerId, crewIds));
      await db.update(ocMembers)
        .set({ released: true })
        .where(inArray(ocMembers.playerId, crewIds));

      // Create fresh heist
      const createRes = await app.inject({
        method: "POST",
        url: "/api/oc",
        headers: { authorization: `Bearer ${leaderToken}` },
        payload: { buyIn: "1000" },
      });
      expect(createRes.statusCode, `round ${i} create: ${createRes.body}`).toBe(201);
      const { heistId } = createRes.json();

      // Invite full crew (mastermind=leader already accepted via create)
      const crew = [
        { username: "DriverA", role: "driver", token: driverAToken },
        { username: "Gunman", role: "gunman", token: gunmanToken },
        { username: "Hacker", role: "hacker", token: hackerToken },
      ];
      for (const c of crew) {
        const inv = await app.inject({
          method: "POST",
          url: `/api/oc/${heistId}/invite`,
          headers: { authorization: `Bearer ${leaderToken}` },
          payload: { targetUsername: c.username, role: c.role },
        });
        expect(inv.statusCode, `round ${i} invite ${c.username}: ${inv.body}`).toBe(201);
      }

      // All crew accepts
      for (const c of crew) {
        const acc = await app.inject({
          method: "POST",
          url: `/api/oc/${heistId}/accept`,
          headers: { authorization: `Bearer ${c.token}` },
        });
        expect(acc.statusCode, `round ${i} accept ${c.username}: ${acc.body}`).toBe(200);
      }

      // Use a per-round blocker barrier to hold the heist row so both
      // requests park before either proceeds. Without this, the two
      // fire() calls race for the heist lock in deterministic scheduling
      // order and one always wins — the race is never exercised.
      const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
      const t0 = await blocker.reserve();
      const inFlight: Promise<LightMyRequestResponse>[] = [];

      try {
        await t0`BEGIN`;
        await t0`SELECT id FROM p_oc_heists WHERE id = ${heistId}::uuid FOR UPDATE`;

        // Both paths lock the heist row first, so the winner is determined
        // by which request's SELECT ... FOR UPDATE reaches Postgres first.
        // To introduce genuine scheduling nondeterminism, we dispatch from
        // separate microtask batches (setImmediate equivalent) so the event
        // loop can reorder them. On odd rounds we also add a 1ms delay to
        // the leave dispatch to bias toward execute winning.
        let ex: Promise<LightMyRequestResponse>, lv: Promise<LightMyRequestResponse>;
        if (i % 2 === 0) {
          // Normal order — leave's shorter pipeline (no accessInJail check)
          // tends to reach lockHeist first.
          ex = fire({ method: "POST", url: `/api/oc/${heistId}/execute`, headers: { authorization: `Bearer ${leaderToken}` } });
          lv = fire({ method: "POST", url: `/api/oc/${heistId}/leave`, headers: { authorization: `Bearer ${hackerToken}` } });
        } else {
          // Delay leave to let execute reach the lock first.
          lv = new Promise<LightMyRequestResponse>((resolve) =>
            setTimeout(() => resolve(fire({ method: "POST", url: `/api/oc/${heistId}/leave`, headers: { authorization: `Bearer ${hackerToken}` } })), 2),
          );
          ex = fire({ method: "POST", url: `/api/oc/${heistId}/execute`, headers: { authorization: `Bearer ${leaderToken}` } });
        }
        inFlight.push(ex, lv);
        await waitForLockWaiters(2);
        await t0`ROLLBACK`; // release together from the same instant

        const [exRes, lvRes] = await Promise.all([ex, lv]);

        const executed = exRes.statusCode === 202;
        const left = lvRes.statusCode === 200;
        expect(executed !== left, `round ${i}: ex=${exRes.statusCode} lv=${lvRes.statusCode} — both won or both lost`).toBe(true);

        // Refund check: delta against cumulative count (rows accumulate across iterations)
        const refunds = await db.select().from(transactions)
          .where(and(eq(transactions.playerId, hackerId), eq(transactions.reason, "oc.refund")));
        const delta = refunds.length - totalRefunds;
        expect(delta, `round ${i} refund delta`).toBe(left ? 1 : 0);
        totalRefunds = refunds.length;

        interleavings.push({ round: i, ex: exRes.statusCode, lv: lvRes.statusCode, executed, left });
        console.log(`  round ${i}: ex=${exRes.statusCode} lv=${lvRes.statusCode} executed=${executed} left=${left}`);
      } finally {
        try { await t0`ROLLBACK`; } catch { /* already rolled back */ }
        await Promise.allSettled(inFlight);
        t0.release();
        await blocker.end();
      }
    }

    // Both interleavings must be observed — the heist lock serialises but does
    // not impose a fixed winner. If only one ever appears, the race isn't
    // being exercised and the test is the shape rule-6's corollary warns about.
    const executeWins = interleavings.filter((r) => r.executed).length;
    const leaveWins = interleavings.filter((r) => r.left).length;
    expect(executeWins, `execute wins: ${executeWins}/20`).toBeGreaterThan(0);
    expect(leaveWins, `leave wins: ${leaveWins}/20`).toBeGreaterThan(0);
    console.log(`\nInterleaving summary: execute=${executeWins}/20, leave=${leaveWins}/20`);
  }, 120_000);
});
