import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { items, locations, playerItems, playerStats } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The player↔player lock order, proven against the ABBA it is there to
 * prevent: A shoots B while B shoots A.
 *
 * `tx.locks.player` sorts its ids ascending and locks them in ONE ordered
 * statement, so both directions of a mutual attack queue on the same row
 * first and no cycle can form. Take the sort away — lock the caller first and
 * the target second, in caller order — and the two requests hold each other's
 * first row while asking for the second: 40P01, uncaught, HTTP 500 on a
 * well-formed request.
 *
 * WHY A BARRIER RATHER THAN A LOOP OF `Promise.all` ROUNDS.
 * Firing both attacks together and hoping they interleave is a coin flip per
 * round: the cycle only forms if both grab their first row before either
 * grabs its second. The blocker connection below holds BOTH player rows, so
 * each request parks on its own first lock, and releasing the blocker starts
 * them from the same instant with the cycle already set up. That makes the
 * red deterministic instead of probabilistic — which matters, because
 * NOTES.md's corollary to rule 6 is that a concurrency test nobody has seen
 * fail proves nothing.
 *
 * BOTH PARTICIPANTS ARE REAL REQUESTS, deliberately. A hand-written adversary
 * locking B-then-A would deadlock the CORRECT code too whenever A sorts below
 * B — an outside actor taking locks in arbitrary order is not something any
 * internal ordering can defend against, so such a test would prove the
 * opposite of what it claims. The blocker here only synchronises the start;
 * it never takes the two rows in a conflicting order.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let tokenA: string;
let tokenB: string;
let playerA: string;
let playerB: string;

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

/** A weapon that always hits for 1 — enough to reach the writes, never a kill. */
async function equipPeashooter(playerId: string): Promise<void> {
  const id = uuidv7();
  await db.insert(items).values({
    id,
    name: `w-${id.slice(-8)}`,
    itemType: "weapon",
    // `backfireChance: 0` for the same reason as `accuracy: 100` — a backfire
    // returns before the target is ever touched, so the shot would take only
    // one of the two player locks this test exists to order.
    effects: { accuracy: 100, damageMin: 1, damageMax: 1, backfireChance: 0 },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
}

const attack = (targetId: string, token: string): InjectOptions => ({
  method: "POST",
  url: `/api/combat/attack/${targetId}`,
  headers: { authorization: `Bearer ${token}` },
});

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  ({ token: tokenA, playerId: playerA } = await registerVerifiedPlayer({ app, redis }, { username: "Tommy" }));
  ({ token: tokenB, playerId: playerB } = await registerVerifiedPlayer({ app, redis }, { username: "Paulie" }));

  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  await db
    .update(playerStats)
    .set({
      locationId,
      exp: 100_000n,
      // Routed (gl3-profile) boot: the newbie gate reads level, not exp.
      level: 100,
      bullets: 1000n,
      health: 100,
      gangId: null,
      jailedUntil: null,
      hospitalUntil: null,
    })
    .where(inArray(playerStats.playerId, [playerA, playerB]));
  await equipPeashooter(playerA);
  await equipPeashooter(playerB);
});

afterAll(async () => {
  // Targeted deletes of these two players' own keys — never FLUSHDB. Both ids
  // are fresh uuidv7s, so nothing else in the suite owns them.
  await redis.del(cooldownKey(playerA, "combat.attack"));
  await redis.del(cooldownKey(playerB, "combat.attack"));
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("combat lock ordering", () => {
  it("survives A-shoots-B and B-shoots-A released from the same barrier", async () => {
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

      const ab = fire(attack(playerB, tokenA));
      const ba = fire(attack(playerA, tokenB));
      inFlight.push(ab, ba);

      // Both requests are now parked on their FIRST lock. Under caller-order
      // locking those are different rows (each its own), which is the cycle;
      // under the shipped sorted lock they are the same row, which is not.
      await waitForLockWaiters(2);

      // Starts both from the same instant.
      await t0`ROLLBACK`;

      const [abRes, baRes] = await Promise.all([ab, ba]);

      // A deadlock surfaces as 40P01 → an unhandled error → HTTP 500.
      expect(abRes.statusCode, `A→B body: ${abRes.body}`).not.toBe(500);
      expect(baRes.statusCode, `B→A body: ${baRes.body}`).not.toBe(500);
      // Neither is merely rejected early, either: both shots really resolved.
      expect([abRes.statusCode, baRes.statusCode]).toEqual([200, 200]);

      // 1 damage each way, whatever the order the two transactions ran in.
      const rows = await db
        .select({ playerId: playerStats.playerId, health: playerStats.health })
        .from(playerStats)
        .where(inArray(playerStats.playerId, [playerA, playerB]));
      expect(rows.map((r) => r.health)).toEqual([99, 99]);
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
  }, 30_000);

  it("survives repeated unsynchronised mutual attacks", async () => {
    // NOT the regression proof — without the barrier the interleaving is
    // luck, and a green run here says nothing about ordering. It covers the
    // handler running against itself under ordinary concurrency, which the
    // barrier test's single controlled release does not.
    for (let round = 0; round < 8; round += 1) {
      await redis.del(cooldownKey(playerA, "combat.attack"));
      await redis.del(cooldownKey(playerB, "combat.attack"));
      await db
        .update(playerStats)
        .set({ health: 100, hospitalUntil: null })
        .where(inArray(playerStats.playerId, [playerA, playerB]));

      const [ab, ba] = await Promise.all([
        fire(attack(playerB, tokenA)),
        fire(attack(playerA, tokenB)),
      ]);

      expect(ab.statusCode, `round ${round} A→B: ${ab.body}`).not.toBe(500);
      expect(ba.statusCode, `round ${round} B→A: ${ba.body}`).not.toBe(500);
    }
  }, 30_000);
});
