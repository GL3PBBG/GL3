import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crimes, locations, players, playerStats, transactions } from "../src/db/schema/index.js";
import { seedCrimes, seedLocations, seedRanks } from "../src/db/seed.js";
import bankPlugin from "@gl3/plugin-bank";
import { PluginError } from "@gl3/plugin-sdk";
import { applyBalanceChange, InsufficientFundsError } from "../src/economy/ledger.js";
import { processCrimeJob } from "../src/game/crimes/worker.js";
import { AlreadyAtLocationError, LocationNotFoundError, performTravel } from "../src/game/travel/service.js";
import { InsufficientStockError, NoLocationError, performBulletsPurchase } from "../src/game/bullets/service.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const PLAYER_COUNT = 5;
const OP_COUNT = 1000;
const STARTING_CASH = 50_000n;

// This file calls processCrimeJob/performBankTransaction directly (no
// bootTestServer, no HTTP), so nothing namespaces their leaderboard writes
// automatically the way a booted test server would. Both take an optional
// trailing `leaderboardPrefix` — pass a run-unique one so this file never
// zadd's into the shared, global `leaderboard:*` keys other concurrent
// test files/agents may be reading.
const leaderboardPrefix = `invariant-test-${uuidv7()}`;

let playerIds: string[] = [];
let crimeIds: string[] = [];
let locationIds: string[] = [];

beforeAll(async () => {
  await resetDb(db);
  await seedCrimes(db);
  await seedRanks(db);
  await seedLocations(db);

  crimeIds = (await db.select({ id: crimes.id }).from(crimes)).map((r) => r.id);
  locationIds = (await db.select({ id: locations.id }).from(locations)).map((r) => r.id);

  for (let i = 0; i < PLAYER_COUNT; i += 1) {
    const id = uuidv7();
    await db.insert(players).values({ id, username: `invariant${i}-${Date.now()}` });
    // Funded well above any single op's cost so most ops succeed and the
    // invariant is exercised under real balance movement, not mostly-rejects.
    await db.insert(playerStats).values({ playerId: id, cash: STARTING_CASH });
    playerIds.push(id);
  }
});
afterAll(async () => {
  // Best-effort: only ever removes this run's own namespaced keys, never
  // the shared `leaderboard:*` keys production/other tests read.
  await redis.del(`${leaderboardPrefix}:cash`, `${leaderboardPrefix}:bank`, `${leaderboardPrefix}:exp`);
  await conn.end();
  redis.disconnect();
});

/** Deterministic, dependency-free PRNG for choosing which op runs next — not spec-governed randomness, just test-harness variety. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("economy invariant across every M2 money path", () => {
  // 1000 sequential in-process DB ops comfortably clears the default 5s
  // vitest timeout under load; the brief's own "well under a minute" budget
  // needs an explicit ceiling.
  it("keeps sum(ledger) == balance, per player, per kind, across 1000 randomized ops", async () => {
    const rand = mulberry32(20260807);
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

    // Op-type/outcome tallies purely for the assertion below and the task
    // report — not part of the invariant itself.
    const OP_NAMES = ["crime", "bank", "travel", "bullets", "points"] as const;
    const attempted = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0 };
    const succeeded = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0 };

    for (let i = 0; i < OP_COUNT; i += 1) {
      const playerId = pick(playerIds);
      // 5 op kinds: the four M2 game-money paths, plus a direct ledger op so
      // `points` — a real BalanceKind with no game feature wired to it yet
      // in M2 (no crime/bank/travel/bullets path ever touches it) — is
      // still exercised under the same randomized sweep instead of sitting
      // at a trivial 0 == 0 for the whole run. applyBalanceChange is the
      // ledger's own sanctioned mutator (economy/ledger.ts), the same
      // function every game path above calls under the hood, so this is
      // still "every mutation is a plain callable function" (Decision 7),
      // not a test-only reimplementation.
      const opName = OP_NAMES[Math.floor(rand() * OP_NAMES.length)]!;
      attempted[opName] += 1;
      try {
        if (opName === "crime") {
          await processCrimeJob(
            db, redis, { id: `invariant-crime-${i}`, data: { playerId, crimeId: pick(crimeIds), seed: `invariant-seed-${i}` } },
            leaderboardPrefix,
          );
        } else if (opName === "bank") {
          const direction = rand() < 0.5 ? "deposit" : "withdraw";
          const amount = BigInt(1 + Math.floor(rand() * 200));
          // bank is a plugin now; this drives its real route handler.
          await callPluginRoute(bankPlugin, "POST", `/api/bank/${direction}`, {
            db, redis, leaderboardPrefix, playerId, body: { amount: amount.toString() },
          });
        } else if (opName === "travel") {
          await performTravel(db, redis, playerId, pick(locationIds));
        } else if (opName === "bullets") {
          const quantity = 1 + Math.floor(rand() * 5);
          await performBulletsPurchase(db, redis, playerId, quantity);
        } else {
          const direction = rand() < 0.5 ? "credit" : "debit";
          const amount = BigInt(1 + Math.floor(rand() * 100));
          await db.transaction((tx) =>
            applyBalanceChange(tx, {
              playerId, kind: "points", reason: `test.points.${direction}`,
              amount: direction === "credit" ? amount : -amount,
            }));
        }
        succeeded[opName] += 1;
      } catch (err) {
        // Expected, frequent rejections that must NOT corrupt state: insufficient
        // funds/stock, already-at-location, no-location-yet. Anything else is a
        // real bug and must fail the test.
        if (
          err instanceof InsufficientFundsError || err instanceof AlreadyAtLocationError ||
          err instanceof InsufficientStockError || err instanceof NoLocationError ||
          err instanceof LocationNotFoundError ||
          // bank is a plugin now: its overdraft arrives as the PluginError its
          // handler throws, not as core's InsufficientFundsError. The other
          // four ops are still core and still throw core classes.
          (err instanceof PluginError && err.code === "insufficient_funds")
        ) continue;
        throw err;
      }
    }

    const totalSucceeded = Object.values(succeeded).reduce((a, b) => a + b, 0);
    // Surfaced deliberately (op mix + success rate) for the task report, not a leftover debug log.
    console.log("economy-invariant op mix", { attempted, succeeded, totalSucceeded, OP_COUNT });
    // A gate that mostly rejects proves nothing about real balance movement —
    // guard against that degenerating silently in the future.
    expect(totalSucceeded / OP_COUNT).toBeGreaterThan(0.5);

    for (const playerId of playerIds) {
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      if (!stats) throw new Error(`missing player_stats for ${playerId}`);

      const kinds = { cash: stats.cash, bank: stats.bank, points: stats.points } as const;
      for (const kind of ["cash", "bank", "points"] as const) {
        const ledgerRows = await db.select({ amount: transactions.amount })
          .from(transactions)
          .where(and(eq(transactions.playerId, playerId), eq(transactions.balanceKind, kind)));
        const ledgerSum = ledgerRows.reduce((sum, r) => sum + r.amount, 0n);
        const expected = kind === "cash" ? STARTING_CASH + ledgerSum : ledgerSum;
        expect(kinds[kind], `player ${playerId} kind ${kind}`).toBe(expected);
      }
    }
  }, 60_000);
});
