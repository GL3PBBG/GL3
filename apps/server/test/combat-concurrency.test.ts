import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  items,
  locations,
  playerItems,
  playerStats,
  transactions,
} from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { combatLog } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Two killers, one victim on 1 hp holding cash: the classic double-payout.
 *
 * Both shots are fatal on their own. If they read the victim's health and
 * cash outside a lock, each sees 1 hp and 300k and each pays itself the full
 * 300k — money minted out of a stale read, with the ledger left describing a
 * transfer that happened once. The player lock is the only thing serialising
 * them, and the loser must come back 409 `target_hospitalised` off a re-read
 * that observes the winner's commit.
 *
 * The blocker connection is a barrier, not an adversary: it holds the victim
 * row so both requests are provably in flight before either can proceed, then
 * releases them together. Firing them with a bare `Promise.all` and hoping
 * they overlap is the shape CLAUDE.md's corollary to rule 6 warns about — a
 * test that can silently stop exercising the race and still look green.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token1: string;
let token2: string;
let killer1: string;
let killer2: string;
let victim: string;

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

async function register(username: string): Promise<{ token: string; playerId: string }> {
  return registerVerifiedPlayer({ app, redis }, { username });
}

/** 50 damage at accuracy 100 — fatal against a 1-hp victim, certain to land. */
async function equipExecutioner(playerId: string): Promise<void> {
  const id = uuidv7();
  await db.insert(items).values({
    id,
    name: `w-${id.slice(-8)}`,
    itemType: "weapon",
    // `backfireChance: 0` for the same reason as `accuracy: 100` — the
    // default `combat.backfire.base_chance` of 2 would otherwise let one shot
    // in fifty return early, which under concurrency reads as a lost race.
    effects: { accuracy: 100, damageMin: 50, damageMax: 50, backfireChance: 0 },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
}

const cashOf = async (playerId: string): Promise<bigint> => {
  const [row] = await db
    .select({ cash: playerStats.cash })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  return row?.cash ?? 0n;
};

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  ({ token: token1, playerId: killer1 } = await register("Nicky"));
  ({ token: token2, playerId: killer2 } = await register("Gerry"));
  ({ playerId: victim } = await register("Spider"));

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
      cash: 0n,
      gangId: null,
      jailedUntil: null,
      hospitalUntil: null,
    })
    .where(inArray(playerStats.playerId, [killer1, killer2, victim]));
  await equipExecutioner(killer1);
  await equipExecutioner(killer2);
  await db
    .update(playerStats)
    .set({ health: 1, cash: 300_000n })
    .where(eq(playerStats.playerId, victim));
});

afterAll(async () => {
  // Targeted deletes of these players' own keys — never FLUSHDB.
  await redis.del(cooldownKey(killer1, "combat.attack"));
  await redis.del(cooldownKey(killer2, "combat.attack"));
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("two shots on one dying victim", () => {
  it("pays exactly one killer and 409s the other", async () => {
    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      // Hold the victim's row. Both attacks need it — the shipped code for its
      // player lock, an unlocked variant for the health UPDATE — so this
      // parks them whichever way the route is written.
      await t0`BEGIN`;
      await t0`SELECT player_id FROM player_stats WHERE player_id = ${victim}::uuid FOR UPDATE`;

      const auth = (token: string): InjectOptions => ({
        method: "POST",
        url: `/api/combat/attack/${victim}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const r1 = fire(auth(token1));
      const r2 = fire(auth(token2));
      inFlight.push(r1, r2);
      await waitForLockWaiters(2);

      await t0`ROLLBACK`;
      const [res1, res2] = await Promise.all([r1, r2]);

      expect(
        [res1.statusCode, res2.statusCode].sort(),
        `bodies: ${res1.body} | ${res2.body}`,
      ).toEqual([200, 409]);
      const loser = res1.statusCode === 409 ? res1 : res2;
      // Not any 409: the loser must lose because it RE-READ the victim after
      // the lock and saw the hospital deadline the winner wrote.
      expect(loser.json()).toMatchObject({ error: "target_hospitalised" });

      // Exactly one payout. The bug this lock prevents is both killers
      // crediting themselves from the same 300k read, which reads as 600k.
      const [c1, c2, cv] = await Promise.all([cashOf(killer1), cashOf(killer2), cashOf(victim)]);
      expect(c1 + c2).toBe(300_000n);
      expect(cv).toBe(0n);

      // One shot resolved, so one row — the loser threw before the insert.
      const logRows = await db.select().from(combatLog);
      expect(logRows).toHaveLength(1);
      expect(logRows[0]).toMatchObject({ fatal: true, payout: 300_000n });

      // And the ledger agrees on all three. Asserted as a DELTA against the
      // seeded balances, not as `sum(ledger) == balance`: the seeding above
      // sets cash with a raw UPDATE and writes no ledger row, so the global
      // invariant is broken by the setup, not by the route. `resetDb` runs
      // before any of it, so every row present belongs to this attack.
      const before = new Map([
        [killer1, 0n],
        [killer2, 0n],
        [victim, 300_000n],
      ]);
      for (const id of [killer1, killer2, victim]) {
        const rows = await db.select().from(transactions).where(eq(transactions.playerId, id));
        const sum = rows.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
        expect(sum, `ledger delta for ${id}`).toBe((await cashOf(id)) - (before.get(id) ?? 0n));
      }

      // Zero-sum across the whole fight: money moved, none was minted.
      const all = await db.select().from(transactions);
      const combatRows = all.filter((t) => t.reason.startsWith("combat."));
      expect(combatRows.reduce((acc, t) => acc + t.amount, 0n)).toBe(0n);
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
});
