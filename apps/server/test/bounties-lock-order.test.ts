import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, afterAll as vitestAfterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  items,
  locations,
  playerItems,
  playerStats,
} from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Bounty placement racing combat on the same player pair.
 *
 * Player A (placer) places bounties on player B (attacker) while B attacks A.
 * Both transactions lock both player rows. Combat locks via `tx.locks.player`
 * sorted ascending. The bounty place route also locks via `tx.locks.player`
 * sorted ascending, then later the bounty INSERT's FKs take `FOR KEY SHARE` on
 * both rows — the same pair combat holds.
 *
 * If the two codepaths disagree on order the interleaving deadlocks (40P01),
 * which surfaces as a 500. The rule-6 corollary: participants must NOT share
 * lock acquisition by construction, and here they don't — different routes,
 * different plugins, different handlers.
 *
 * `Promise.all` alone is not enough to prove they overlap (the
 * combat-concurrency lesson). A blocker connection holds the placer's
 * `player_stats` row so both requests are provably in flight before either
 * can proceed past the contested point, then releases them together.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;

// Player A: places bounties
let placerToken: string;
let placerId: string;

// Player B: attacks the placer
let attackerToken: string;
let attackerId: string;
let attackerName: string;

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
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

async function makeAttackable(): Promise<string> {
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
    .where(inArray(playerStats.playerId, [placerId, attackerId]));
  return locationId;
}

/** Seeds an item and equips it as `weaponItemId`. Returns the item id. */
async function equipWeapon(
  playerId: string,
  effects: Record<string, unknown>,
): Promise<string> {
  const id = uuidv7();
  // Spread first so a caller can override. See combat.test.ts's equipWeapon
  // for why: the default `combat.backfire.base_chance` of 2 otherwise gives
  // every shot a 2% chance of returning early with no kill and no filter run.
  await db.insert(items).values({
    id,
    name: `w-${id.slice(-8)}`,
    itemType: "weapon",
    effects: { backfireChance: 0, ...effects },
  });
  await db
    .insert(playerItems)
    .values({ playerId, itemId: id, qty: 1 });
  await db
    .update(playerStats)
    .set({ weaponItemId: id })
    .where(eq(playerStats.playerId, playerId));
  return id;
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  const placer = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Placer", password: "hunter2hunter2" },
  });
  ({ token: placerToken, playerId: placerId } = placer.json());

  const attacker = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Attacker", password: "hunter2hunter2" },
  });
  ({ token: attackerToken, playerId: attackerId } = attacker.json());
  attackerName = attacker.json().username;
});

vitestAfterAll(async () => {
  await redis.del(cooldownKey(attackerId, "combat.attack"));
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("bounty placement racing combat on the same pair", () => {
  it("never deadlocks: both routes lock the pair ascending", async () => {
    await makeAttackable();
    // 1 damage so nobody dies mid-test (100 hp, 10 rounds).
    await equipWeapon(attackerId, { accuracy: 100, damageMin: 1, damageMax: 1 });
    await db
      .update(playerStats)
      .set({ cash: 10_000_000n })
      .where(eq(playerStats.playerId, placerId));

    // Open a raw connection to act as a blocker — hold a row so both
    // requests queue behind it, guaranteeing true concurrency on release.
    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();

    try {
      for (let round = 0; round < 10; round += 1) {
        // Clear the attack cooldown between rounds so the attacker is never
        // blocked by Redis. Targeted DEL of this player's own key — never FLUSHDB.
        await redis.del(cooldownKey(attackerId, "combat.attack"));

        // Hold the placer's `player_stats` row. Both paths lock
        // `player_stats` rows via `tx.locks.player` (which sorts ascending),
        // and the bounty route also touches it via `applyBalanceChange`.
        // Holding it parks both requests, guaranteeing they are both in flight
        // and will race for the remaining lock on release.
        await t0`BEGIN`;
        await t0`SELECT player_id FROM player_stats WHERE player_id = ${placerId}::uuid FOR UPDATE`;

        const inFlight: Promise<LightMyRequestResponse>[] = [];
        const r1 = fire({
          method: "POST",
          url: "/api/bounties",
          headers: { authorization: `Bearer ${placerToken}` },
          payload: { targetUsername: attackerName, amount: "1000" },
        });
        const r2 = fire({
          method: "POST",
          url: `/api/combat/attack/${placerId}`,
          headers: { authorization: `Bearer ${attackerToken}` },
        });
        inFlight.push(r1, r2);
        await waitForLockWaiters(2);

        await t0`ROLLBACK`;
        const [placeRes, attackRes] = await Promise.all([r1, r2]);

        // Any legal outcome is fine (200/201/409/423/429) — what may never
        // appear is a 500, which is what a 40P01 deadlock surfaces as.
        expect(
          placeRes.statusCode,
          `place round ${round}: ${placeRes.body}`,
        ).toBeLessThan(500);
        expect(
          attackRes.statusCode,
          `attack round ${round}: ${attackRes.body}`,
        ).toBeLessThan(500);
      }
    } finally {
      try {
        await t0`ROLLBACK`;
      } catch {
        /* already rolled back */
      }
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});
