import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { sweepExpiredSentences } from "../src/game/sweep/sweeper.js";
import { items, locations, playerItems, playerStats } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { pgErrorCode } from "./helpers/pg-error.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { createOutboxDelivery } from "../src/bus/outbox.js";

/**
 * The sweeper↔combat lock pair, proven against the ABBA it must never form.
 *
 * NOTES.md rule 6's corollary is that a concurrency test whose participants
 * all lock through the same helper proves only the case that was already
 * safe. `combat-lock-order.test.ts` (the fixture this file copies) exercises
 * combat against itself — two callers of the SAME `lockPlayersForUpdate`
 * helper. This file exercises a genuinely different shape: the sweeper's
 * one-lock-at-a-time path (`dischargeIfExpired`, Task 3) against combat's
 * two-sorted-locks path, a pair that has never been exercised before.
 *
 * WHY A BARRIER RATHER THAN A LOOP OF `Promise.all` ROUNDS.
 * Firing a sweep and two attacks together and hoping they interleave is a
 * coin flip per round. The blocker connection below holds BOTH player rows,
 * so every participant parks on its own first lock, and releasing the
 * blocker starts them from the same instant with the cycle — if the code can
 * form one — already set up. That makes the red deterministic instead of
 * probabilistic.
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
    // returns before the target is touched, so the shot would not take the
    // locks whose order this test exists to pin.
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

describe("sentence sweeper lock ordering", () => {
  it("survives a sweep released from the same barrier as a mutual attack", async () => {
    // Both players have an ELAPSED hospital sentence, so the sweeper has real
    // work on both rows — and `dischargeIfExpired` is the sweeper path that
    // actually takes a player lock (jail's release is a bare UPDATE). Combat
    // settles elapsed sentences for both participants itself, so the two
    // paths are contending for exactly the same two rows.
    const past = new Date(Date.now() - 1000);
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: past })
      .where(inArray(playerStats.playerId, [playerA, playerB]));

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<unknown>[] = [];

    try {
      // Hold BOTH rows in ascending order — the shipped helper's own order,
      // so this barrier is not itself an out-of-order actor.
      await t0`BEGIN`;
      await t0`
        SELECT player_id FROM player_stats
        WHERE player_id IN (${playerA}::uuid, ${playerB}::uuid)
        ORDER BY player_id FOR UPDATE
      `;

      const ab = fire(attack(playerB, tokenA));
      const ba = fire(attack(playerA, tokenB));
      const sweep = sweepExpiredSentences(db, createOutboxDelivery(db, { redis }));
      inFlight.push(ab, ba, sweep);

      // Three backends parked on their first lock.
      await waitForLockWaiters(3);

      await t0`ROLLBACK`; // starts all three from the same instant

      const [abRes, baRes] = await Promise.all([ab, ba]);
      // A deadlock surfaces as 40P01 → unhandled → HTTP 500.
      expect(abRes.statusCode, `A→B body: ${abRes.body}`).not.toBe(500);
      expect(baRes.statusCode, `B→A body: ${baRes.body}`).not.toBe(500);

      // And the sweep itself neither deadlocked nor was starved out.
      const error = await sweep.then(() => undefined, (e: unknown) => e);
      expect(pgErrorCode(error)).not.toBe("40P01");
      expect(error).toBeUndefined();
    } finally {
      try { await t0`ROLLBACK`; } catch { /* already rolled back */ }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});
