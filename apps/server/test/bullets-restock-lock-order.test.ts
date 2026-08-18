import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Redis } from "ioredis";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Regression test for the lock order of the bullet restock, which is the first
 * thing in the game to touch EVERY location row in one transaction.
 *
 * Travel takes its two location rows through `lockLocationsForUpdate`, which
 * sorts them ascending. A restock that locked in any other order — including
 * the scan order a bare multi-row `UPDATE` would use — closes an ABBA cycle
 * against it: the restock holding the higher id and waiting on the lower,
 * travel holding the lower and waiting on the higher. 40P01, uncaught, and a
 * well-formed shop view answers 500.
 *
 * The adversary is hand-written raw SQL rather than the real travel route, per
 * the rule-6 corollary in NOTES.md: a concurrency test whose participants all
 * acquire through the same helper proves only the case that was already safe.
 * `gang-ledger.test.ts`'s deadlock test agreed on ordering by construction and
 * stayed green straight through the M3 deadlock it was meant to catch.
 *
 * Demonstrated red by flipping `restock.ts`'s `orderBy(asc(...))` to `desc`:
 * the shop request then fails with 40P01 instead of returning 200.
 *
 * Each step waits on observed lock state in pg_stat_activity, never a sleep.
 */
const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let lowId: string;
let highId: string;

function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  // app.inject() is lazy — it dispatches only when something calls .then.
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
  ({ app, close: closeServer, redis } = await bootTestServer());

  // Two ids in a known order: the restock must take them low-then-high.
  const a = uuidv7();
  const b = uuidv7();
  [lowId, highId] = a < b ? [a, b] : [b, a];
  await db.insert(locations).values([
    { id: lowId, name: "Lowville", travelCost: 10n, travelCooldownSeconds: 60, bulletStock: 0, bulletCost: 5n },
    { id: highId, name: "Highton", travelCost: 10n, travelCooldownSeconds: 60, bulletStock: 0, bulletCost: 5n },
  ]);

  const reg = await registerVerifiedPlayer({ app, redis }, { username: `RestockLock${Date.now()}` });
  token = reg.token;
  await db.update(playerStats).set({ cash: 10_000n, locationId: highId })
    .where(eq(playerStats.playerId, reg.playerId));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("bullet restock lock ordering", () => {
  it("does not deadlock against a travel holding the lower location id", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const inFlight: Promise<LightMyRequestResponse>[] = [];
    const t0 = await blocker.reserve();

    try {
      // t0 = a travel between these two towns, in travel's lock shape: both
      // location rows, ascending, via lockLocationsForUpdate.
      await t0`BEGIN`;
      await t0`SELECT id FROM locations WHERE id = ${lowId}::uuid FOR UPDATE`;

      // No cursor row exists, so this shop view is 12 hours overdue and will
      // restock. It must want the LOW id first and park there.
      const shop = fire({ method: "GET", url: "/api/bullets/shop", headers: auth });
      inFlight.push(shop);
      await waitForLockWaiters(1);

      // Travel's second row. With the restock ordered descending this closes
      // the cycle: it holds high and wants low, t0 holds low and wants high.
      await t0`SELECT id FROM locations WHERE id = ${highId}::uuid FOR UPDATE`;
      await t0`COMMIT`;

      const res = await shop;
      expect(res.statusCode, `shop body: ${res.body}`).toBeLessThan(500);
      expect(res.statusCode).toBe(200);
      // And it did the work it was blocking on, rather than skipping it.
      expect(res.json<{ bulletStock: number }>().bulletStock).toBeGreaterThan(0);
    } finally {
      try { await t0`ROLLBACK`; } catch { /* already committed */ }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});
