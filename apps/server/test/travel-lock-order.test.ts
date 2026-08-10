import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Regression test for the location↔player lock-order inversion between
 * `travel` and `bullets`.
 *
 * Before the fix, core's performTravel took `player_stats` FOR UPDATE first
 * and reached `locations` afterwards — implicitly, as the FOR KEY SHARE
 * Postgres takes when `UPDATE player_stats SET location_id = …` checks its
 * foreign key. A bullets purchase locks the other way round: `locations` FOR
 * UPDATE first (tx.locks.location), then `player_stats` inside
 * applyBalanceChange. FOR KEY SHARE conflicts with FOR UPDATE, so a buy
 * holding locations[L] while a travel INTO L holds that player's row is a
 * genuine cycle: 40P01, uncaught, and a well-formed request answers 500.
 *
 * WHY THE ADVERSARY IS HAND-WRITTEN, not the real bullets handler.
 * The cycle needs a buy to hold locations[L] while the player sits somewhere
 * else — so that a travel's destination can be L. But the real handler derives
 * L from player_stats.location_id and locks it in the same uninterrupted
 * stretch of code; making that read stale means moving the player between the
 * read and the lock, a window internal to the handler with no hook. Every
 * blocker placement collapses: on player_stats the player cannot move, on
 * locations[L] the intervening travel needed to move them deadlocks the SETUP
 * against the fixed code, and doing that travel first makes the buy read C
 * instead of L. A test-only pause inside the shipped bullets transaction was
 * rejected — it would put scaffolding inside a verified port to expose the
 * very window this port removes.
 *
 * So t0 below stands in for a buy that read L before the move, in bullets'
 * exact lock shape: locations[L] FOR UPDATE, then player_stats[P] FOR UPDATE.
 * That still satisfies docs/STATUS.md's requirement that the two sides not
 * acquire their locks through the same helper — which matters because
 * gang-ledger.test.ts's deadlock test agreed on ordering by construction and
 * stayed green straight through the M3 deadlock it was meant to catch.
 *
 * Each step waits on observed lock state in pg_stat_activity, never a sleep.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let lId: string;
let cId: string;

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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  lId = uuidv7();
  cId = uuidv7();
  await db.insert(locations).values([
    { id: lId, name: "Lockville", travelCost: 10n, travelCooldownSeconds: 60, bulletStock: 100, bulletCost: 5n },
    { id: cId, name: "Cooltown", travelCost: 10n, travelCooldownSeconds: 60, bulletStock: 100, bulletCost: 5n },
  ]);

  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `LockOrder${Date.now()}`, password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
  await db.update(playerStats).set({ cash: 10_000n, locationId: lId }).where(eq(playerStats.playerId, playerId));
});

afterAll(async () => {
  await redis.del(cooldownKey(playerId, "travel"));
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("travel lock ordering", () => {
  it("does not deadlock when a travel INTO a location races a purchase already holding it", async () => {
    const auth = { authorization: `Bearer ${token}` };

    // Move P off L first, so a travel back INTO L is legal (destination ==
    // current is rejected before any lock is taken). Cooldown cleared between
    // legs, as travel.test.ts does.
    const out = await app.inject({ method: "POST", url: `/api/travel/${cId}`, headers: auth });
    expect(out.statusCode).toBe(200);
    await redis.del(cooldownKey(playerId, "travel"));

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const inFlight: Promise<LightMyRequestResponse>[] = [];
    const t0 = await blocker.reserve();

    try {
      // t0 = a buy that read L before the move, in bullets' lock shape.
      await t0`BEGIN`;
      await t0`SELECT id FROM locations WHERE id = ${lId}::uuid FOR UPDATE`;

      // Real travel C→L. Pre-fix it takes player_stats[P] FOR UPDATE and then
      // parks on locations[L]. Post-fix it parks on locations[L] holding no
      // player row at all.
      const back = fire({ method: "POST", url: `/api/travel/${lId}`, headers: auth });
      inFlight.push(back);
      await waitForLockWaiters(1);

      // The second half of the buy's shape. Pre-fix this closes the cycle:
      // t0 holds L and wants P, travel holds P and wants L.
      await t0`SELECT player_id FROM player_stats WHERE player_id = ${playerId}::uuid FOR UPDATE`;
      await t0`COMMIT`;

      const backRes = await back;
      expect(backRes.statusCode, `travel body: ${backRes.body}`).toBeLessThan(500);
      expect(backRes.statusCode).toBe(200);

      const [row] = await db.select({ locationId: playerStats.locationId })
        .from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.locationId).toBe(lId);
    } finally {
      try { await t0`ROLLBACK`; } catch { /* already committed */ }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);

  it("survives a real purchase and a real travel running concurrently", async () => {
    // NOT the regression proof. This cannot force the cycle — see the header
    // comment for why the stale-read window is unreachable from outside the
    // bullets handler. It covers the two shipped handlers coexisting under
    // concurrency, and nothing more. Do not read a green run here as evidence
    // about lock ordering.
    const auth = { authorization: `Bearer ${token}` };
    await redis.del(cooldownKey(playerId, "travel"));

    const [buyRes, travelRes] = await Promise.all([
      fire({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 1 } }),
      fire({ method: "POST", url: `/api/travel/${cId}`, headers: auth }),
    ]);

    expect(buyRes.statusCode, `buy body: ${buyRes.body}`).toBeLessThan(500);
    expect(travelRes.statusCode, `travel body: ${travelRes.body}`).toBeLessThan(500);

    // Whatever the interleaving, the ledger balances.
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    const sum = rows.reduce((acc, r) => acc + (r.balanceKind === "cash" ? r.amount : 0n), 0n);
    const [stats] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBe(10_000n + sum);
  }, 30_000);
});
