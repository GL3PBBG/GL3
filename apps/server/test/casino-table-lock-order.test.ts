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
import { casinoSeats, casinoTables, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The TABLE cluster's lock order under concurrency — rule 6's regression for
 * `lockTable`, modelled wholesale on `casino-lock-order.test.ts` (the solo
 * hub's) and sharing its `waitForLockWaiters`, its barrier and its
 * deliberate-inversion choreography.
 *
 * WHAT THE ROUTES DO. Every mutating table route (`sit`, `leave`, `bet`,
 * `act`, and the GET's slow path) takes, in this exact order:
 * `tx.locks.location(the table's town)`, then ONE sorted `tx.locks.player`
 * over every seated player PLUS the frozen house's owner PLUS any extras
 * (`sit`'s caller, who has no seat row yet), then the table row `FOR UPDATE`.
 * `packages/plugins/casino/src/table-engine.ts:29` is the single place that
 * order is expressed, which is why one test file can pin all five routes.
 *
 * The table edge is NOT the solo hub's edge re-tested. Solo `play` locks at
 * most two player rows — the buyer and the house owner — and the table locks
 * up to SIX, every one of which belongs to a person who can be sitting at
 * another table in another town at the same instant. The pair {A, B} the ABBA
 * case below constructs is the smallest such cycle.
 *
 * WHAT EACH TEST PROVES, and what it does not:
 *
 *  1. A-bets-at-B's-table racing B-bets-at-A's-table, in two different towns.
 *     THE LOAD-BEARING ONE: it is what goes red with a real `40P01` when
 *     `lockTable`'s single `tx.locks.player([...ids])` is split into one call
 *     per id (the caller's seat first, the house owner second — the Set's
 *     insertion order). Verbatim server-log proof of that red is in the task
 *     report; over HTTP a deadlock is visible only as a 500, because Fastify's
 *     error handler strips the pg code from the body.
 *     It does NOT prove anything about the location lock — the two towns are
 *     different rows and neither request ever waits on the other's.
 *  2. the deliberate inversion, `casino-lock-order`'s test-4 choreography
 *     verbatim against `bet`. CLAUDE.md's corollary to rule 6: a concurrency
 *     test whose participants all acquire locks via the same helper proves
 *     only the case that was already safe. A second connection takes
 *     `player_stats` BEFORE `locations` — the shipped travel bug's shape — and
 *     is expected to die of 40P01 while the route answers in full.
 *  3. two sitters racing one empty town. `sit` hands out the seat number
 *     itself, from the seat set it read under the location lock, and
 *     `p_casino_seats_table_seat` UNIQUE (table_id, seat_no) is only the
 *     backstop — a backstop that would surface as an uncaught 23505, i.e. a
 *     500 on a well-formed request. This is the case where BOTH requests want
 *     the same location row, so it measures the location lock the ABBA case
 *     above deliberately does not.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep. The one
 * `setTimeout` below is not a wait for state: it is a deliberate margin
 * between two deadlock-detector timers, explained where it appears.
 */

const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

/** Every wager in this file. 100,000 * blackjack's 2.5 = 250,000 exposure. */
const WAGER = "100000";
/** The owner's lever, comfortably above WAGER so `wager_above_max` is not in play. */
const HOUSE_LEVER = 1_000_000n;
const HOUSE_CASH = 10_000_000n;
const PLAYER_CASH = 1_000_000n;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  // Registration is rate-limited per IP and the app is booted once, so every
  // registration in this file shares one bucket unless the address differs.
  return registerVerifiedPlayer({ app, redis }, {
    username: `Dealer${regCounter}`,
    remoteAddress: `10.64.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

async function seedLocation(): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id,
    name: `city-${id.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  return id;
}

/** `casino-tables.test.ts`'s `seedHouse`: `cost` is the owner's lever. */
async function seedHouse(locationId: string, ownerId: string, cost: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId, pluginId: "blackjack", ownerPlayerId: ownerId, cost, profit: 0n,
  });
  return id;
}

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats)
    .set({ locationId, cash, jailedUntil: null, hospitalUntil: null })
    .where(eq(playerStats.playerId, playerId));
}

function sit(token: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST", url: "/api/casino/table/sit",
    headers: { authorization: `Bearer ${token}` }, payload: { gameId: "blackjack" },
  });
}

const sitOpts = (token: string): InjectOptions => ({
  method: "POST",
  url: "/api/casino/table/sit",
  headers: { authorization: `Bearer ${token}` },
  payload: { gameId: "blackjack" },
});

const betOpts = (token: string): InjectOptions => ({
  method: "POST",
  url: "/api/casino/table/bet",
  headers: { authorization: `Bearer ${token}` },
  payload: { wager: WAGER },
});

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

/**
 * `raceTwoPlays`, generalised over the request: fires two table requests
 * released from one barrier that holds BOTH player rows in ascending id order
 * — the same order the shipped `tx.locks.player` call uses, so the barrier is
 * not itself an out-of-order actor. Each request parks on its first contended
 * lock, and releasing the barrier starts them from the same instant with the
 * interleaving already set up: the red is deterministic rather than a coin
 * flip per round (CLAUDE.md rule 6's corollary).
 *
 * The two requests need not both park on `player_stats`: in the seat race
 * below one parks on the shared `locations` row instead, which is still a
 * lock-waiting backend and still released by the same rollback.
 */
async function raceTwo(
  first: { id: string; opts: InjectOptions },
  second: { id: string; opts: InjectOptions },
): Promise<[LightMyRequestResponse, LightMyRequestResponse]> {
  const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
  const t0 = await blocker.reserve();
  const inFlight: Promise<LightMyRequestResponse>[] = [];

  try {
    await t0`BEGIN`;
    await t0`
      SELECT player_id FROM player_stats
      WHERE player_id IN (${first.id}::uuid, ${second.id}::uuid)
      ORDER BY player_id FOR UPDATE
    `;

    const a = fire(first.opts);
    const b = fire(second.opts);
    inFlight.push(a, b);

    // Both requests are now parked on their FIRST contended lock.
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
  // `casino` and `blackjack` are both CORE_PLUGIN entries, and blackjack is
  // the table game, so no explicit plugin list or migration call is needed.
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("casino table lock ordering", () => {
  it("survives A-bets-at-B's-table racing B-bets-at-A's-table", async () => {
    // THE ABBA PAIR, and the reason `lockTable`'s single sorted
    // `tx.locks.player` call is load-bearing. Two towns with a blackjack house
    // in each, CROSS-OWNED, and each player sits alone in the OTHER's town.
    // Both lock sets are therefore the same pair {A, B}: A's bet locks itself
    // (its seat) and B (the house it plays against), B's bet locks itself and
    // A. Under one sorted call both requests queue on the same first row and
    // no cycle is constructible.
    //
    // Split that call — one `tx.locks.player` per id, in the Set's insertion
    // order, which is the seated caller first and the house owner second — and
    // A holds player_stats[A] wanting player_stats[B] while B holds [B]
    // wanting [A]: 40P01, uncaught, HTTP 500 on a well-formed request. Shown
    // red exactly that way; the verbatim output is in the task report.
    //
    // The two towns are DIFFERENT `locations` rows on purpose: neither request
    // ever waits on the other's location lock, so the only edge under test
    // here is the player↔player one inside `lockTable`.
    const a = await register();
    const b = await register();
    const locX = await seedLocation();
    const locY = await seedLocation();
    // A owns the house in X; B owns the house in Y.
    await seedHouse(locX, a.playerId, HOUSE_LEVER);
    await seedHouse(locY, b.playerId, HOUSE_LEVER);
    // Each player stands in the OTHER's town, and each is also the house for
    // the other's hand, so each needs to cover both a wager and the exposure.
    await placePlayer(a.playerId, locY, HOUSE_CASH);
    await placePlayer(b.playerId, locX, HOUSE_CASH);

    // A sits alone at Y's table (house owner B); B sits alone at X's (owner A).
    const sitA = await sit(a.token);
    const sitB = await sit(b.token);
    expect(sitA.statusCode, `A sit body: ${sitA.body}`).toBe(200);
    expect(sitB.statusCode, `B sit body: ${sitB.body}`).toBe(200);
    const tableA = sitA.json<{ tableId: string }>().tableId;
    const tableB = sitB.json<{ tableId: string }>().tableId;
    expect(tableA).not.toBe(tableB);

    const [aRes, bRes] = await raceTwo(
      { id: a.playerId, opts: betOpts(a.token) },
      { id: b.playerId, opts: betOpts(b.token) },
    );

    // A deadlock is uncaught: 40P01 -> HTTP 500 on a well-formed request.
    expect(aRes.statusCode, `A body: ${aRes.body}`).not.toBe(500);
    expect(bRes.statusCode, `B body: ${bRes.body}`).not.toBe(500);
    expect([aRes.statusCode, bRes.statusCode]).toEqual([200, 200]);

    // Both bets really landed — a 200 that escrowed nothing would make the
    // assertion above vacuous.
    const seatsA = await db.select().from(casinoSeats).where(eq(casinoSeats.tableId, tableA));
    const seatsB = await db.select().from(casinoSeats).where(eq(casinoSeats.tableId, tableB));
    expect(seatsA).toHaveLength(1);
    expect(seatsB).toHaveLength(1);
    // A single seat that bets completes its table, so `dealIfReady` fired and
    // both tables left the betting phase (or settled straight back into it on
    // a natural, having bumped `hand_no`).
    const [rowA] = await db.select().from(casinoTables).where(eq(casinoTables.id, tableA));
    const [rowB] = await db.select().from(casinoTables).where(eq(casinoTables.id, tableB));
    expect(rowA?.handNo).toBe(1);
    expect(rowB?.handNo).toBe(1);
  }, 30_000);

  it("deadlocks when a caller takes the player lock before the location lock", async () => {
    const player = await register();
    const locationId = await seedLocation();
    // UNOWNED town: the route's lock set is exactly {locations[L],
    // player_stats[P], the table row}, so this test measures the
    // location↔player edge and nothing else.
    await placePlayer(player.playerId, locationId, PLAYER_CASH);
    const sitRes = await sit(player.token);
    expect(sitRes.statusCode, `sit body: ${sitRes.body}`).toBe(200);

    // Held in an object so the assertion below reads it after the helper has
    // thrown: the route outlives the inverted actor's abort, and what it
    // answered is the other half of the proof.
    const out: { route: Promise<LightMyRequestResponse> | null } = { route: null };

    /**
     * The inverted actor: `player_stats` FIRST, then `locations` — the exact
     * shape the shipped travel deadlock had, against the real `bet` route.
     *
     * WHY THREE CONNECTIONS. Postgres kills whichever waiter's own
     * deadlock_timeout expires first, and `deadlock_timeout` is not settable
     * by this test's role. So the inverted actor must START WAITING BEFORE the
     * route does, or the route is the victim and the deadlock shows up as an
     * opaque HTTP 500 instead of a rejection here. `hold` takes locations[L]
     * first; the route queues behind it (holding nothing — locations is its
     * FIRST lock); the inverted actor takes player_stats[P] and queues behind
     * the route on locations[L]. Releasing `hold` hands locations[L] to the
     * route in queue order, and the route then wants player_stats[P] via
     * `lockTable`: the cycle closes with the inverted actor having waited
     * longest, so it is the one that detects and aborts.
     */
    async function raceAgainstInvertedOrder(): Promise<void> {
      const url = loadConfig(process.env).databaseUrl;
      const holdPool = postgres(url, { max: 1 });
      const invPool = postgres(url, { max: 1 });
      const hold = await holdPool.reserve();
      const inv = await invPool.reserve();
      const pending: Promise<unknown>[] = [];

      try {
        await hold`BEGIN`;
        await hold`SELECT id FROM locations WHERE id = ${locationId}::uuid FOR UPDATE`;

        const route = fire(betOpts(player.token));
        out.route = route;
        pending.push(route);
        await waitForLockWaiters(1);

        await inv`BEGIN`;
        // INVERTED: the player row first...
        await inv`SELECT player_id FROM player_stats WHERE player_id = ${player.playerId}::uuid FOR UPDATE`;
        // ...and the location row second. Promise.resolve dispatches it now.
        const invWantsLocation = Promise.resolve(
          inv`SELECT id FROM locations WHERE id = ${locationId}::uuid FOR UPDATE`,
        );
        pending.push(invWantsLocation);
        await waitForLockWaiters(2);

        // NOT a wait for state — both waiters are already observed above. This
        // is a deliberate margin between the two deadlock-detector timers: the
        // inverted actor has been waiting since before this line, the route
        // starts waiting on player_stats[P] just after it, so the inverted
        // actor's timer expires first and it becomes the victim. Well under
        // the 1s deadlock_timeout, so the cycle exists when that timer fires.
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        await hold`ROLLBACK`;

        await invWantsLocation;
      } finally {
        for (const t of [hold, inv]) {
          try {
            await t`ROLLBACK`;
          } catch {
            /* already rolled back, or aborted by the deadlock */
          }
        }
        await Promise.allSettled(pending);
        hold.release();
        inv.release();
        await holdPool.end();
        await invPool.end();
      }
    }

    await expect(raceAgainstInvertedOrder()).rejects.toThrow(/40P01|deadlock/);

    // The other half: the route was NOT the victim. The shipped order survived
    // a cycle it did not create and answered the request in full — a 500 here
    // would mean Postgres picked the well-ordered side, and the rejection
    // above would have been proving the wrong thing.
    if (out.route === null) throw new Error("the bet request was never dispatched");
    const routeRes = await out.route;
    expect(routeRes.statusCode, `bet body: ${routeRes.body}`).toBe(200);
  }, 60_000);

  it("seats two racing sitters at 0 and 1, never a 23505 out of the seat unique", async () => {
    // THE SEAT RACE, and the one case here where both requests want the SAME
    // `locations` row. `sit` chooses the seat number in JS — the lowest gap in
    // the seat set it read — so two sitters that both read an empty town would
    // both choose seat 0, and `p_casino_seats_table_seat` UNIQUE
    // (table_id, seat_no) would reject the loser as an uncaught 23505: HTTP
    // 500 on a well-formed request. What stops that is the location lock being
    // taken FIRST and held for the whole transaction, which serializes the
    // read-choose-insert entirely; the unique index is the backstop, and this
    // test is what says so.
    //
    // Empty, unowned town: the loser blocks on `locations[L]` and never
    // reaches the player lock at all, which is why the barrier's second waiter
    // is a location waiter here and a player waiter in the ABBA case.
    const one = await register();
    const two = await register();
    const locationId = await seedLocation();
    await placePlayer(one.playerId, locationId, PLAYER_CASH);
    await placePlayer(two.playerId, locationId, PLAYER_CASH);

    const [resOne, resTwo] = await raceTwo(
      { id: one.playerId, opts: sitOpts(one.token) },
      { id: two.playerId, opts: sitOpts(two.token) },
    );

    // THE ASSERTION. A 23505 escaping as a 500 lands here, as does a 40P01.
    const statuses = [resOne.statusCode, resTwo.statusCode];
    expect(statuses, `bodies: ${resOne.body} | ${resTwo.body}`).not.toContain(500);
    expect(statuses, `bodies: ${resOne.body} | ${resTwo.body}`).toEqual([200, 200]);

    // The loser saw the winner's table under the location lock it then took —
    // READ COMMITTED gives its `SELECT ... FROM p_casino_tables` a fresh
    // snapshot — so it joined that table rather than opening a second one.
    const bodyOne = resOne.json<{ tableId: string; seat: number }>();
    const bodyTwo = resTwo.json<{ tableId: string; seat: number }>();
    expect(bodyTwo.tableId).toBe(bodyOne.tableId);
    expect([bodyOne.seat, bodyTwo.seat].sort()).toEqual([0, 1]);

    // And the rows agree with what the two responses claimed.
    const seats = await db.select().from(casinoSeats)
      .where(eq(casinoSeats.tableId, bodyOne.tableId));
    expect(seats).toHaveLength(2);
    expect(seats.map((s) => s.seatNo).sort()).toEqual([0, 1]);
    expect(seats.map((s) => s.playerId).sort()).toEqual([one.playerId, two.playerId].sort());
  }, 30_000);
});
