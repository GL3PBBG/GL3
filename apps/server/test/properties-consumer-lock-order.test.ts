import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * `payOwner`'s consumer-side lock rule (its doc comment,
 * `packages/plugins/properties/src/api.ts`): a consumer that also acts on a
 * player OTHER than the one `payOwner` locks (the buyer, vs `payOwner`'s
 * owner) must take BOTH through ONE sorted `tx.locks.player` call before
 * either balance moves. `bullets` is the first consumer to do this
 * (`packages/plugins/bullets/src/index.ts`), and this is its regression —
 * modelled on `apps/server/test/combat-lock-order.test.ts`, the player↔player
 * precedent, whose barrier shape this reuses directly.
 *
 * THE SHAPE. Two locations, each with a bullets factory: A owns the one at
 * locB, B owns the one at locA. Each player stands in the OTHER's town: A at
 * locB (buying from B's factory — touching {A, B}), B at locA (buying from
 * A's factory — touching {B, A}). Both lock sets are the SAME pair, {A, B}:
 * under the shipped single sorted `tx.locks.player([buyer, ownerId])` call
 * both requests queue on the same first row and cannot cycle. Take the sort
 * away — lock the buyer alone, then let `payOwner` lock the owner second, in
 * its own separate statement — and A's buy holds player_stats[A] wanting
 * player_stats[B] while B's buy holds player_stats[B] wanting
 * player_stats[A]: 40P01, uncaught, HTTP 500 on a well-formed request.
 *
 * WHY A BARRIER, not a loop of `Promise.all` rounds. Firing both together and
 * hoping they interleave is a coin flip per round — the cycle only forms if
 * both grab their first row before either grabs its second. The blocker
 * below holds BOTH player rows, in ascending id order (the same order the
 * shipped code uses), so each request parks on its own first lock, and
 * releasing the blocker starts them from the same instant with the cycle
 * already set up. That makes the red deterministic rather than probabilistic
 * — NOTES.md's corollary to rule 6 is that a concurrency test nobody has
 * seen fail proves nothing.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

let tokenA: string;
let tokenB: string;
let playerA: string;
let playerB: string;

const startingCash = 1_000_000_000n;

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

const buy = (token: string): InjectOptions => ({
  method: "POST",
  url: "/api/bullets/buy",
  headers: { authorization: `Bearer ${token}` },
  payload: { quantity: 1 },
});

/**
 * Fires A's buy (from B's factory) and B's buy (from A's factory) released
 * from one barrier holding both player rows. Shared by both tests below so
 * un-skipping the second one exercises the identical race.
 */
async function raceBothBuys(): Promise<[LightMyRequestResponse, LightMyRequestResponse]> {
  const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
  const t0 = await blocker.reserve();
  const inFlight: Promise<LightMyRequestResponse>[] = [];

  try {
    // Hold BOTH rows, in ascending order — the same order the shipped
    // helper uses, so this barrier is not itself an out-of-order actor.
    await t0`BEGIN`;
    await t0`
      SELECT player_id FROM player_stats
      WHERE player_id IN (${playerA}::uuid, ${playerB}::uuid)
      ORDER BY player_id FOR UPDATE
    `;

    const a = fire(buy(tokenA));
    const b = fire(buy(tokenB));
    inFlight.push(a, b);

    // Both requests are now parked on their FIRST lock.
    await waitForLockWaiters(2);

    // Starts both from the same instant.
    await t0`ROLLBACK`;

    return await Promise.all([a, b]);
  } finally {
    try {
      await t0`ROLLBACK`;
    } catch {
      /* already rolled back */
    }
    await Promise.allSettled(inFlight);
    t0.release();
    await blocker.end();
  }
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  const a = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Frankieoak", password: "hunter2hunter2" },
  });
  ({ token: tokenA, playerId: playerA } = a.json());
  const b = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Frankiepine", password: "hunter2hunter2" },
  });
  ({ token: tokenB, playerId: playerB } = b.json());

  const locA = uuidv7();
  const locB = uuidv7();
  await db.insert(locations).values([
    { id: locA, name: `loc-a-${locA.slice(-8)}`, bulletStock: 1_000_000, bulletCost: 5n },
    { id: locB, name: `loc-b-${locB.slice(-8)}`, bulletStock: 1_000_000, bulletCost: 5n },
  ]);
  // A owns the factory at locA; B owns the factory at locB. cost 0n: no
  // lever set, so the buy still falls back to the location's own price —
  // the lock behaviour under test does not depend on which price applies.
  await db.insert(propertiesPlugin).values([
    { id: uuidv7(), locationId: locA, pluginId: "bullets", ownerPlayerId: playerA, cost: 0n, profit: 0n },
    { id: uuidv7(), locationId: locB, pluginId: "bullets", ownerPlayerId: playerB, cost: 0n, profit: 0n },
  ]);

  // Each player stands in the OTHER's town: A buys from B's factory, B buys
  // from A's factory — the ABBA pair.
  await db.update(playerStats)
    .set({ cash: startingCash, locationId: locB, jailedUntil: null, hospitalUntil: null })
    .where(eq(playerStats.playerId, playerA));
  await db.update(playerStats)
    .set({ cash: startingCash, locationId: locA, jailedUntil: null, hospitalUntil: null })
    .where(eq(playerStats.playerId, playerB));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("properties consumer lock ordering", () => {
  it("survives A-buys-from-B's-factory racing B-buys-from-A's-factory", async () => {
    const [aRes, bRes] = await raceBothBuys();

    // A deadlock surfaces as 40P01 -> an unhandled error -> HTTP 500.
    expect(aRes.statusCode, `A buy body: ${aRes.body}`).not.toBe(500);
    expect(bRes.statusCode, `B buy body: ${bRes.body}`).not.toBe(500);
    // Neither is merely rejected early either: both purchases really resolved.
    expect([aRes.statusCode, bRes.statusCode]).toEqual([200, 200]);
  }, 30_000);

  // Skipped by default. Un-skip after changing bullets' buy route's
  // `tx.locks.player(...)` call to `tx.locks.player([player.id])` alone
  // (dropping the owner, letting `payOwner` lock it second in its own
  // statement), and confirm this goes red with a 40P01 deadlock or a hung
  // request. A green concurrency test whose participants agree on ordering
  // by construction proves nothing (NOTES.md rule 6 corollary) — this is
  // that proof, run against the SAME race as the test above.
  it.skip("proves the test can fail: locking the buyer alone deadlocks", async () => {
    const [aRes, bRes] = await raceBothBuys();
    expect(aRes.statusCode, `A buy body: ${aRes.body}`).not.toBe(500);
    expect(bRes.statusCode, `B buy body: ${bRes.body}`).not.toBe(500);
    expect([aRes.statusCode, bRes.statusCode]).toEqual([200, 200]);
  }, 30_000);
});
