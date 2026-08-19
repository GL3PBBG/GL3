import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  items, locations, playerItems, playerStats, roundEntries, rounds, settings, transactions,
} from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { combatLog } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The rounds↔player lock order — the FOURTH lock pair in this codebase, after
 * gang↔player, location↔player and player↔player (CLAUDE.md rule 6).
 *
 * WHAT IS BEING PROVEN. `settle()` takes `pg_advisory_xact_lock(7461002)` as
 * its first statement, before any table is touched; the payout that follows
 * reaches `player_stats` through `applyBalanceChange`, and pre-locks the whole
 * winner set once via `lockPlayersForUpdate` so those rows are taken in ONE
 * ascending-id statement. Paying the winners one at a time in PLACING order
 * instead — placing is by delta, which is uncorrelated with player id — is the
 * specific inversion this file exists to catch: it makes finalize hold
 * `player_stats[B]` while asking for `player_stats[A]`, which closes an ABBA
 * cycle with any ascending-order actor holding A and wanting B. A real combat
 * attack between the same two players is exactly that actor, and the cycle is
 * a 40P01: uncaught, so a well-formed request answers 500.
 *
 * WHY A BARRIER, and not a loop of concurrent requests. CLAUDE.md's corollary
 * to rule 6: a concurrency test whose participants all take their locks
 * through the same helper proves only the case that was already safe, and
 * firing requests together and hoping they interleave is a coin flip per run.
 * So the counterparties here are REAL ROUTES reaching `player_stats` through
 * their own doors — a `bank` deposit (one player, via `applyBalanceChange`)
 * and a `combat` attack (two players, via `tx.locks.player`) — and a separate
 * connection holds the row they both queue on, so the interleaving is fixed by
 * construction before anything is released. Two concurrent `ensureCurrentRound`
 * calls would agree on ordering by construction and prove nothing; that race
 * is `rounds-rollover.test.ts`'s job, and it is a different question.
 *
 * THE BLOCKER HOLDS `player_stats[A]`, NOT THE ADVISORY LOCK. It must hold
 * exactly one lock — a transaction holding one lock and asking for nothing
 * cannot be half of a cycle — and it must be one the queued actors actually
 * want. `ROUNDS_LOCK` is first in finalize's own order but no counterparty
 * takes it, so a blocker holding it could queue nothing behind itself; the
 * first CONTENDED lock in the canonical order is the lowest-id player row, and
 * that is what is held below. Every canonical actor that wants A parks on it
 * holding nothing, so the barrier is not itself an out-of-order actor.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep.
 *
 * TWO THINGS THAT LOOK LIKE GAPS IN THIS FILE AND ARE NOT.
 *
 * 1. The freeze (`UPDATE round_entries … FROM player_stats`) reads
 *    `player_stats` WITHOUT locking it — a plain `FROM` takes no row locks. A
 *    money move racing the freeze therefore lands on one side of the
 *    statement's snapshot or the other, and which side is a "which instant"
 *    question, not corruption. This file asserts conservation (rule 3:
 *    `sum(ledger) == balance`) and never asserts which side a specific racing
 *    transfer fell on. Placings here are ranked on `exp`, which no
 *    counterparty below moves, so the payout is deterministic regardless.
 *
 * 2. `round_entries`' foreign keys take FOR KEY SHARE on `players` and on
 *    `rounds`. Nothing in the repo takes FOR UPDATE on `players` — core's FOR
 *    UPDATE sites are `player_stats`, `locations` and `gangs`
 *    (`economy/ledger.ts`), and plugins add their own only on tables they own
 *    (`p_theft_cars`, `p_oc_heists`, `p_properties_properties`) — so that FK
 *    edge contends with nothing today. The contended row is `player_stats`,
 *    reached by the payout, which is the whole of the second half of the rule.
 */

const { db, sql: conn } = testDb();
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
const redis = createRedis(config.redisUrl);

/**
 * Deliberately NOT the default [1000n, 500n, 250n] in any position, so a
 * silent fallback to the default award table — because the row was seeded
 * after boot, or never read — cannot masquerade as a correct run.
 */
const AWARD_POINTS: readonly bigint[] = [777n, 333n, 111n];

/** Seeded balances, so conservation can be checked against a known origin. */
const START_CASH = 1_000_000n;
const START_BANK = 1_000_000n;
const DEPOSIT = 500n;
const WITHDRAWAL = 250n;

let app: FastifyInstance;
let closeServer: () => Promise<void>;

/** Registered first, so `playerA < playerB` as uuidv7s — asserted in beforeAll. */
let playerA: string;
let playerB: string;
let tokenA: string;
let tokenB: string;
/** Not an entrant: it only drives GET /api/rounds, which is what settles. */
let tokenCaller: string;

const ago = (ms: number): Date => new Date(Date.now() - ms);

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

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

/**
 * A weapon that always hits for 1 — enough to reach the writes, never a kill,
 * and never a backfire. Both matter here: a kill would move the victim's cash
 * mid-freeze and a backfire returns before the target row is written, so the
 * shot would exercise only one of the two player locks under test.
 */
async function equipPeashooter(playerId: string): Promise<void> {
  const id = uuidv7();
  await db.insert(items).values({
    id,
    name: `w-${id.slice(-8)}`,
    itemType: "weapon",
    effects: { accuracy: 100, damageMin: 1, damageMax: 1, backfireChance: 0 },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
}

/**
 * An already-ended, already-snapshotted round with A and B entered on deltas
 * that place B FIRST and A SECOND. That inverted correlation is the point:
 * placing order is descending delta, id order is ascending uuid, and the
 * regression under test is a payout that follows the former.
 */
async function seedEndedRound(
  name: string, deltaA: bigint, deltaB: bigint,
): Promise<string> {
  const id = uuidv7();
  await db.insert(rounds).values({
    id, name, startsAt: ago(7_200_000), endsAt: ago(3_600_000), snapshottedAt: ago(7_200_000),
  });
  const [statsA] = await db.select({ exp: playerStats.exp }).from(playerStats)
    .where(eq(playerStats.playerId, playerA));
  const [statsB] = await db.select({ exp: playerStats.exp }).from(playerStats)
    .where(eq(playerStats.playerId, playerB));
  await db.insert(roundEntries).values([
    { roundId: id, playerId: playerA, expAtStart: statsA!.exp - deltaA },
    { roundId: id, playerId: playerB, expAtStart: statsB!.exp - deltaB },
  ]);
  return id;
}

const payoutsFor = (roundId: string) => db.select().from(transactions)
  .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, roundId)));

/** A deadlock is uncaught, so it surfaces as a 500 — but assert on the SQLSTATE
 * itself too, in case a future error handler starts forwarding the body. */
function assertNoDeadlock(label: string, res: LightMyRequestResponse): void {
  const where = `${label} -> ${res.statusCode}: ${res.body}`;
  expect(res.body, where).not.toContain("40P01");
  expect(res.body.toLowerCase(), where).not.toContain("deadlock");
  expect(res.statusCode, where).not.toBe(500);
}

/**
 * Rule 3, measured from the seeded origin rather than from zero: the balances
 * were set by hand in beforeAll, so the ledger accounts for every move SINCE.
 */
async function expectConserved(playerId: string, points: bigint): Promise<void> {
  const ledger = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
  const sumOf = (kind: string): bigint =>
    ledger.reduce((acc, r) => acc + (r.balanceKind === kind ? r.amount : 0n), 0n);
  const [stats] = await db
    .select({ cash: playerStats.cash, bank: playerStats.bank, points: playerStats.points })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  expect(stats?.cash, `cash for ${playerId}`).toBe(START_CASH + sumOf("cash"));
  expect(stats?.bank, `bank for ${playerId}`).toBe(START_BANK + sumOf("bank"));
  expect(stats?.points, `points for ${playerId}`).toBe(sumOf("points"));
  expect(sumOf("points"), `points ledger for ${playerId}`).toBe(points);
}

beforeAll(async () => {
  await resetDb(db);
  // Settings are read once at boot into a plain record (settings/load.ts), so
  // this row must exist BEFORE bootTestServer() calls buildApp().
  await db.insert(settings).values({
    key: "rounds.payout_points",
    value: JSON.stringify(AWARD_POINTS.map((n) => n.toString())),
  });
  ({ app, close: closeServer } = await bootTestServer());

  ({ token: tokenA, playerId: playerA } = await register("Lockstep"));
  ({ token: tokenB, playerId: playerB } = await register("Ratchet"));
  ({ token: tokenCaller } = await register("Bystander"));

  // Registration ids are uuidv7, so registration order IS id order. The whole
  // file depends on it: A is the row the barrier holds and the row the
  // inverted payout reaches LAST.
  expect(playerA < playerB, `${playerA} must sort below ${playerB}`).toBe(true);

  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  // Same location and exp well above `combat.newbie_exp_threshold` (100), or
  // the attack refuses before it ever takes a lock.
  await db.update(playerStats).set({
    locationId,
    exp: 100_000n,
    cash: START_CASH,
    bank: START_BANK,
    points: 0n,
    bullets: 1000n,
    health: 100,
    gangId: null,
    jailedUntil: null,
    hospitalUntil: null,
  }).where(inArray(playerStats.playerId, [playerA, playerB]));
  await equipPeashooter(playerA);
});

afterAll(async () => {
  // Targeted deletes of this file's own keys — never FLUSHDB. Both ids are
  // fresh uuidv7s, so nothing else in the suite owns them.
  await redis.del(cooldownKey(playerA, "combat.attack"));
  await redis.del(cooldownKey(playerB, "combat.attack"));
  await closeServer?.();
  await conn.end();
  redis.disconnect();
});

describe("rounds lock ordering", () => {
  it("settles a round released from the same barrier as a real attack and a real deposit", async () => {
    const ended = await seedEndedRound("Barrier", 40_000n, 90_000n);

    // `blocker.reserve()` is inside its own try, whose finally always ends
    // the pool — a rejecting reserve() before that finally existed leaked the
    // pool (blocker.end() never ran), which could make a later file's
    // `DROP DATABASE ... WITH (FORCE)` teardown lose its race.
    const blocker = postgres(config.databaseUrl, { max: 1 });
    try {
      const t0 = await blocker.reserve();
      const inFlight: Promise<LightMyRequestResponse>[] = [];

      try {
        // ONE lock, and it is the first CONTENDED lock in the canonical order —
        // the lowest-id player row. Nothing else is taken and nothing else is
        // asked for, so this session cannot be half of a cycle.
        await t0`BEGIN`;
        await t0`SELECT player_id FROM player_stats WHERE player_id = ${playerA}::uuid FOR UPDATE`;

        // Counterparty 1: a real combat attack A→B. `tx.locks.player` is its
        // first statement and locks {A,B} ascending in ONE statement, so it
        // parks on A holding nothing.
        const attack = fire({
          method: "POST",
          url: `/api/combat/attack/${playerB}`,
          headers: auth(tokenA),
        });
        inFlight.push(attack);
        await waitForLockWaiters(1);

        // Counterparty 2: a real bank deposit for A, which reaches
        // `player_stats[A]` through `applyBalanceChange` — a different door
        // again, and one that touches a single row.
        const deposit = fire({
          method: "POST",
          url: "/api/bank/deposit",
          headers: auth(tokenA),
          payload: { amount: DEPOSIT.toString() },
        });
        inFlight.push(deposit);
        await waitForLockWaiters(2);

        // The finalize, queued LAST. GET /api/rounds calls ensureCurrentRound
        // first, which is what makes an ordinary page view settle the round.
        //
        // Under the SHIPPED order it takes ROUNDS_LOCK (uncontended), freezes,
        // ranks, then asks for {A,B} in one ascending statement — so it parks on
        // A holding no player row at all, and nothing can cycle with it.
        //
        // Under a placing-order payout it takes B FIRST (B placed first: higher
        // delta, higher id) and only then asks for A — so it waits on A while
        // HOLDING B, which is exactly what the attack ahead of it wants once it
        // is granted A. 40P01.
        const settle = fire({ method: "GET", url: "/api/rounds", headers: auth(tokenCaller) });
        inFlight.push(settle);
        await waitForLockWaiters(3);

        // Releases all three from the same instant, with the interleaving fixed.
        await t0`ROLLBACK`;

        const [attackRes, depositRes, settleRes] = await Promise.all([attack, deposit, settle]);

        assertNoDeadlock("attack", attackRes);
        assertNoDeadlock("deposit", depositRes);
        assertNoDeadlock("settle", settleRes);
        expect(attackRes.statusCode, `attack body: ${attackRes.body}`).toBe(200);
        expect(depositRes.statusCode, `deposit body: ${depositRes.body}`).toBe(200);
        expect(settleRes.statusCode, `settle body: ${settleRes.body}`).toBe(200);

        // The finalize happened exactly once: one payout row per award actually
        // won, with the seeded award table, in placing order — B first.
        const payouts = await payoutsFor(ended);
        expect(payouts).toHaveLength(2);   // two entrants, three awards
        const byPlayer = new Map(payouts.map((p) => [p.playerId, p.amount]));
        expect(byPlayer.get(playerB)).toBe(AWARD_POINTS[0]);
        expect(byPlayer.get(playerA)).toBe(AWARD_POINTS[1]);
        const finalized = await db.select().from(rounds).where(isNotNull(rounds.finalizedAt));
        expect(finalized).toHaveLength(1);
        expect(finalized[0]!.id).toBe(ended);

        // The counterparties' money moved exactly once each. A deposit is two
        // ledger legs in one transaction, so both are named rather than counted
        // together — a re-applied deposit shows up as a second pair.
        const banked = await db.select().from(transactions)
          .where(and(eq(transactions.playerId, playerA), eq(transactions.reason, "bank.deposit")));
        expect(banked.filter((r) => r.balanceKind === "cash").map((r) => r.amount)).toEqual([-DEPOSIT]);
        expect(banked.filter((r) => r.balanceKind === "bank").map((r) => r.amount)).toEqual([DEPOSIT]);

        // And the attack landed exactly once, for its one point of damage.
        const shots = await db.select().from(combatLog).where(eq(combatLog.attackerId, playerA));
        expect(shots).toHaveLength(1);
        expect(shots[0]!.damage).toBe(1);

        await expectConserved(playerA, AWARD_POINTS[1]!);
        await expectConserved(playerB, AWARD_POINTS[0]!);
      } finally {
        try {
          await t0`ROLLBACK`;
        } catch {
          /* already rolled back */
        }
        await Promise.allSettled(inFlight);
        t0.release();
      }
    } finally {
      await blocker.end();
    }
  }, 60_000);

  it("survives an unsynchronised settle racing real attacks and bank traffic", async () => {
    // NOT the regression proof — without the barrier above the interleaving is
    // luck. This covers the three handlers coexisting under ordinary
    // concurrency, each taking its locks through its OWN code path: finalize's
    // advisory lock + lockPlayersForUpdate, bank's applyBalanceChange, combat's
    // tx.locks.player. No shared driver.
    const ended = await seedEndedRound("Unsynchronised", 30_000n, 80_000n);

    // The attack cooldown is claimed before the transaction and never released
    // on the way out, so the barrier test's shot would otherwise 429 this one.
    await redis.del(cooldownKey(playerA, "combat.attack"));
    await db.update(playerStats).set({ health: 100, hospitalUntil: null })
      .where(inArray(playerStats.playerId, [playerA, playerB]));

    const pending: [string, Promise<LightMyRequestResponse>][] = [
      ["attack", fire({ method: "POST", url: `/api/combat/attack/${playerB}`, headers: auth(tokenA) })],
      ["deposit", fire({
        method: "POST", url: "/api/bank/deposit", headers: auth(tokenA),
        payload: { amount: DEPOSIT.toString() },
      })],
      ["withdraw", fire({
        method: "POST", url: "/api/bank/withdraw", headers: auth(tokenB),
        payload: { amount: WITHDRAWAL.toString() },
      })],
      ...Array.from({ length: 4 }, (_v, i): [string, Promise<LightMyRequestResponse>] => [
        `settle${i}`, fire({ method: "GET", url: "/api/rounds", headers: auth(tokenCaller) }),
      ]),
    ];

    for (const [label, promise] of pending) {
      const res = await promise;
      assertNoDeadlock(label, res);
      expect(res.statusCode, `${label} body: ${res.body}`).toBe(200);
    }

    // Still exactly one payout per award won, across four racing settles.
    expect(await payoutsFor(ended)).toHaveLength(2);

    await expectConserved(playerA, AWARD_POINTS[1]! * 2n);
    await expectConserved(playerB, AWARD_POINTS[0]! * 2n);
  }, 60_000);
});
