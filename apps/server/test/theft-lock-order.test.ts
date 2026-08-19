import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, settings, transactions } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { theftCars, theftGarage, theftTiers } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The location↔player lock order, proven for `theft` against counterparties
 * that do NOT share its helper — the real bullets purchase route and the real
 * travel route.
 *
 * WHAT IS BEING PROVEN. Inserting a `p_theft_garage` row reaches `locations`
 * implicitly through `location_id`'s FK (FOR KEY SHARE), so the naive order —
 * lock the player, insert the row, arrive at the location afterwards — is the
 * shipped travel deadlock exactly. `bullets` locks location→player, so a
 * player→location transaction closes an ABBA cycle with it: 40P01, uncaught,
 * and a well-formed request answers 500. The steal route therefore takes
 * `tx.locks.location(locationId)` and only then `tx.locks.player([id])`
 * (`packages/plugins/theft/src/index.ts`), and design §3 makes that the
 * load-bearing claim of the whole plugin.
 *
 * WHY A BARRIER, and not only a loop of concurrent rounds. CLAUDE.md's
 * corollary to rule 6 is that a concurrency test nobody has seen fail proves
 * nothing, and firing a steal and a travel together and hoping they interleave
 * is a coin flip per round. The first test below holds `locations[L]` on a
 * separate connection, queues a real travel behind it, then queues a real
 * steal behind that, and releases them from one instant with the interleaving
 * already fixed. Under the shipped order that is a deterministic
 * `409 wrong_location`; under the inverted order it is a deterministic 40P01.
 *
 * The blocker is not itself an out-of-order actor: it takes exactly one lock,
 * `locations[L]`, which is the FIRST lock in the canonical order. A
 * transaction holding one lock cannot be half of a cycle.
 *
 * `wrong_location` — the lock-then-recheck TOCTOU defence spec §3 calls "a
 * defence, not an optimisation" — has no other test in the tree, and this is
 * the only place in the plan where the race is produced from real requests
 * rather than by hand-editing a row. The count is asserted at the end of the
 * file for that reason.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

/** Enough concurrent actors that the location row is genuinely contended. */
const PLAYERS = 8;
const ROUNDS = 20;

let app: FastifyInstance;
let closeServer: () => Promise<void>;
/** L is generated FIRST, so `L < C` as uuidv7s — see the barrier test. */
let lId: string;
let cId: string;
let tierId: string;
let tokens: string[] = [];
let playerIds: string[] = [];
let barrierToken: string;
let barrierId: string;

/** Every `409 wrong_location` seen anywhere in this file. */
let wrongLocation = 0;

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

const ErrorBodySchema = z.object({ error: z.string() });

interface Observed {
  label: "steal" | "travel" | "buy";
  status: number;
  error: string | null;
  body: string;
}

/**
 * Awaits one in-flight request and records what it answered. The error string
 * is pulled out here rather than at the assertion so that the allowlist below
 * can be checked case by case — a bare try/catch would swallow exactly the
 * business failures this run is supposed to enumerate.
 */
async function observe(
  label: Observed["label"],
  pending: Promise<LightMyRequestResponse>,
): Promise<Observed> {
  const res = await pending;
  let error: string | null = null;
  if (res.statusCode >= 400 && res.body.length > 0) {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(res.body));
    if (parsed.success) error = parsed.data.error;
  }
  if (label === "steal" && res.statusCode === 409 && error === "wrong_location") wrongLocation += 1;
  return { label, status: res.statusCode, error, body: res.body };
}

/**
 * The refusals a contended run is allowed to produce, enumerated per route.
 * Anything else — including a 500 from an uncaught 40P01 — fails the round it
 * happened in, naming the body.
 *
 *   steal   cooldown_active   the 1s theft cooldown, claimed twice in a round
 *           wrong_location    the TOCTOU recheck: the caller travelled
 *   travel  on_cooldown       the 1s per-location travel cooldown
 *           already_there     destination == current, decided pre-lock
 *           location_changed  three retries lost to the caller's own moves
 *   buy     insufficient_*    stock or cash ran out at this location
 */
const ALLOWED_ERRORS: Record<Observed["label"], readonly string[]> = {
  steal: ["cooldown_active", "wrong_location"],
  travel: ["on_cooldown", "already_there", "location_changed"],
  buy: ["insufficient_stock", "insufficient_funds", "no_location"],
};

/** Success is narrow too: a 100%-success tier always steals, so 201 or bust. */
const ALLOWED_OK: Record<Observed["label"], readonly number[]> = {
  steal: [201],
  travel: [200],
  buy: [200],
};

function assertTolerated(round: number, o: Observed): void {
  const where = `round ${round} ${o.label} -> ${o.status}: ${o.body}`;
  // A deadlock is uncaught, so it surfaces as a 500 — but assert on the code
  // itself too, in case a future error handler starts forwarding the body.
  expect(o.body, where).not.toContain("40P01");
  expect(o.body.toLowerCase(), where).not.toContain("deadlock");
  expect(o.status, where).toBeLessThan(500);
  if (o.status >= 400) {
    expect(ALLOWED_ERRORS[o.label], where).toContain(o.error);
  } else {
    expect(ALLOWED_OK[o.label], where).toContain(o.status);
  }
}

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  // Registration is rate-limited per IP and the app is booted once, so every
  // registration in this file shares one bucket unless the address differs.
  return registerVerifiedPlayer({ app, redis }, {
    username: `Boost${regCounter}`,
    remoteAddress: `10.44.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await resetDb(db);
  // Settings are read into a boot-time snapshot (`settings/load.ts`), so this
  // row must land before bootTestServer or the route keeps the 300s default
  // and no player could steal twice in the whole run.
  await db.insert(settings).values([{ key: "theft.cooldown_seconds", value: "1" }]);
  ({ app, close: closeServer } = await bootTestServer());

  // L before C, so `lId < cId` as uuidv7s. travel locks its two location rows
  // in ascending id order, which makes L the row it blocks on in the barrier
  // test below — the point being that the queue behind the blocker is
  // deterministic, not that either order would be unsafe.
  lId = uuidv7();
  cId = uuidv7();
  await db.insert(locations).values([
    // travelCost 0 keeps travel off applyBalanceChange, which is deliberate:
    // the route then holds only its OWN explicit player lock, so this test
    // measures travel's ordering and not the ledger's.
    // travelCooldownSeconds 1, never 0 — `SET ... EX 0` is a live Redis error.
    { id: lId, name: "Lockville", travelCost: 0n, travelCooldownSeconds: 1, bulletStock: 1_000_000, bulletCost: 1n },
    { id: cId, name: "Cooltown", travelCost: 0n, travelCooldownSeconds: 1, bulletStock: 1_000_000, bulletCost: 1n },
  ]);

  // One car, one tier whose bracket contains it, success_chance 100: every
  // steal that reaches the resolver parks a car, so a failure in this file is
  // never a dice roll. maxDamage 0 keeps the damage roll off the table too.
  await db.insert(theftCars).values({ id: uuidv7(), name: "Sedan", value: 10_000n, theftWeight: 1 });
  tierId = uuidv7();
  await db.insert(theftTiers).values({
    id: tierId,
    name: "Certain",
    successChance: 100,
    maxDamage: 0,
    minCarValue: 1n,
    maxCarValue: 1_000_000n,
  });

  tokens = [];
  playerIds = [];
  for (let i = 0; i < PLAYERS; i += 1) {
    const { token, playerId } = await register();
    tokens.push(token);
    playerIds.push(playerId);
  }
  ({ token: barrierToken, playerId: barrierId } = await register());

  await db
    .update(playerStats)
    .set({ locationId: lId, cash: 1_000_000n, jailedUntil: null, hospitalUntil: null })
    .where(inArray(playerStats.playerId, [...playerIds, barrierId]));
});

afterAll(async () => {
  // Targeted deletes of this file's own keys — never FLUSHDB. Every id is a
  // fresh uuidv7, so nothing else in the suite owns them.
  for (const id of [...playerIds, barrierId]) {
    await redis.del(cooldownKey(id, "travel"));
    await redis.del(cooldownKey(id, "theft"));
  }
  await closeServer?.();
  await conn.end();
  redis.disconnect();
});

describe("theft lock ordering", () => {
  it("answers 409 wrong_location when a real travel commits inside the steal's window", async () => {
    await redis.del(cooldownKey(barrierId, "travel"));
    await redis.del(cooldownKey(barrierId, "theft"));
    await db.update(playerStats).set({ locationId: lId }).where(eq(playerStats.playerId, barrierId));

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      // One lock, and it is the first lock in the canonical order.
      await t0`BEGIN`;
      await t0`SELECT id FROM locations WHERE id = ${lId}::uuid FOR UPDATE`;

      // The real travel L->C. It pre-reads player_stats unlocked, then parks
      // on locations[L] holding no player row at all.
      const travel = fire({ method: "POST", url: `/api/travel/${cId}`, headers: auth(barrierToken) });
      inFlight.push(travel);
      await waitForLockWaiters(1);

      // The real steal, queued BEHIND the travel on the same row. It has
      // already read player_stats.location_id = L by the time it gets here —
      // that read is what the recheck after the lock is about to contradict.
      //
      // Under the SHIPPED order this request holds nothing while it waits.
      // Under the inverted order it holds player_stats[P], which the travel
      // wants after it gets locations[L] — the cycle, and a 40P01.
      const steal = fire({
        method: "POST",
        url: "/api/theft/steal",
        headers: auth(barrierToken),
        payload: { tierId },
      });
      inFlight.push(steal);
      await waitForLockWaiters(2);

      // Releases both from the same instant, with the interleaving fixed.
      await t0`ROLLBACK`;

      const [travelRes, stealRes] = await Promise.all([travel, steal]);

      // A deadlock is uncaught: 40P01 -> HTTP 500 on a well-formed request.
      expect(travelRes.statusCode, `travel body: ${travelRes.body}`).not.toBe(500);
      expect(stealRes.statusCode, `steal body: ${stealRes.body}`).not.toBe(500);

      expect(travelRes.statusCode, `travel body: ${travelRes.body}`).toBe(200);
      expect(stealRes.statusCode, `steal body: ${stealRes.body}`).toBe(409);
      expect(stealRes.json()).toMatchObject({ error: "wrong_location" });
      wrongLocation += 1;

      // The whole point of the recheck: no car is parked in the city the
      // player left. Deleting the check at the steal route's recheck leaves
      // a row here, at lId, owned by a player standing in cId.
      const parked = await db.select().from(theftGarage).where(eq(theftGarage.playerId, barrierId));
      expect(parked).toHaveLength(0);

      const [moved] = await db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, barrierId));
      expect(moved?.locationId).toBe(cId);
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
  }, 60_000);

  it("survives repeated steals, purchases and travels contending for the same rows", async () => {
    // NOT the regression proof — without the barrier the interleaving is luck.
    // This covers the three shipped handlers coexisting under real load, each
    // taking its locks through its OWN code path: theft's tx.locks.location,
    // bullets' tx.locks.location + applyBalanceChange, travel's
    // tx.locks.locations + tx.locks.player. No shared driver.
    const observations: Observed[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      // The 1s cooldowns exist so a player CAN act every round; clearing them
      // is what makes every round actually contended rather than mostly 429.
      for (const id of playerIds) {
        await redis.del(cooldownKey(id, "travel"));
        await redis.del(cooldownKey(id, "theft"));
      }

      // Read where everyone is, so every travel below is a real move rather
      // than a pre-lock `already_there`. Accurate because each player has at
      // most one travel per round and rounds are awaited to completion.
      const where = new Map<string, string | null>();
      const rows = await db
        .select({ playerId: playerStats.playerId, locationId: playerStats.locationId })
        .from(playerStats)
        .where(inArray(playerStats.playerId, playerIds));
      for (const row of rows) where.set(row.playerId, row.locationId);

      const pending: Promise<Observed>[] = [];
      for (let i = 0; i < PLAYERS; i += 1) {
        const token = tokens[i]!;
        const id = playerIds[i]!;
        const destination = where.get(id) === lId ? cId : lId;
        const travel = (): Promise<Observed> =>
          observe("travel", fire({ method: "POST", url: `/api/travel/${destination}`, headers: auth(token) }));
        const steal = (): Promise<Observed> =>
          observe("steal", fire({
            method: "POST",
            url: "/api/theft/steal",
            headers: auth(token),
            payload: { tierId },
          }));
        const buy = (): Promise<Observed> =>
          observe("buy", fire({
            method: "POST",
            url: "/api/bullets/buy",
            headers: auth(token),
            payload: { quantity: 1 },
          }));

        if (i < 4) {
          // A steal racing its OWN travel: the natural producer of the
          // TOCTOU window, whichever way the two land.
          pending.push(steal(), travel());
        } else if (i < 6) {
          pending.push(buy());
        } else {
          pending.push(travel());
        }
      }

      for (const o of await Promise.all(pending)) {
        observations.push(o);
        assertTolerated(round, o);
      }
    }

    // The run did real work, not 240 refusals: at least one steal and one
    // travel per round on average must have gone through.
    const stolen = observations.filter((o) => o.label === "steal" && o.status === 201).length;
    const travelled = observations.filter((o) => o.label === "travel" && o.status === 200).length;
    expect(stolen, `only ${stolen} steals succeeded`).toBeGreaterThan(ROUNDS);
    expect(travelled, `only ${travelled} travels succeeded`).toBeGreaterThan(ROUNDS);

    // Whatever the interleaving, the ledger still balances (rule 3).
    for (const id of playerIds) {
      const ledger = await db.select().from(transactions).where(eq(transactions.playerId, id));
      const sum = ledger.reduce((acc, r) => acc + (r.balanceKind === "cash" ? r.amount : 0n), 0n);
      const [stats] = await db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, id));
      expect(stats?.cash).toBe(1_000_000n + sum);
    }
  }, 120_000);

  it("observed the wrong_location recheck fire at least once", async () => {
    // The recheck at the steal route's lock-then-recheck has no other test in
    // the tree: delete it and every other file stays green. The barrier test
    // above produces this deterministically; the load test usually adds more.
    expect(wrongLocation, `wrong_location occurrences this run: ${wrongLocation}`)
      .toBeGreaterThanOrEqual(1);
  });
});
