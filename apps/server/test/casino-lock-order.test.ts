import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSessions, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The casino's lock order under concurrency — rule 6's regression for the
 * `casino` hub, modelled on `properties-consumer-lock-order.test.ts` (the
 * player↔player precedent) and `theft-lock-order.test.ts` (the location↔player
 * one).
 *
 * WHAT THE ROUTES DO. `play` and `act` take, in this exact order:
 * `tx.locks.location(locationId)`, then `tx.locks.player([...])` with the
 * buyer AND the house owner in ONE sorted, deduped call, then the session row
 * `FOR UPDATE`. The house is a `properties` franchise, so `resolveHouse` reads
 * the owner unlocked (`ownerAt`) and `escrow`/`settleSession` move the house's
 * money through `payOwner`, which re-locks the owner itself — the shape
 * `packages/plugins/properties/src/api.ts:51-67` says a consumer MUST wrap in
 * one sorted call.
 *
 * WHAT EACH TEST PROVES, and what it does not:
 *
 *  1. owner plays at their own table. The dedup branch (`ownerId === player.id`
 *     collapses the lock set to one row) really runs, and a second player at
 *     the same table just queues. It does NOT prove the single-call rule:
 *     between them those two transactions touch only two player rows and one
 *     of them touches a single row, so no cycle is CONSTRUCTIBLE — splitting
 *     the deduped call in two leaves this test green. See test 2.
 *  2. A-plays-at-B's-table racing B-plays-at-A's-table. This is the ABBA pair,
 *     and it is the load-bearing one: it is the test that goes red with a real
 *     `40P01` when the single `tx.locks.player([player.id, house.ownerId])`
 *     call is split into "lock the buyer, let `payOwner` lock the owner
 *     second". Verbatim server-log proof is in the task report — Fastify's
 *     error handler strips the pg code from the body, so a deadlock is visible
 *     over HTTP only as a 500.
 *  3. the deliberate inversion. CLAUDE.md's corollary to rule 6: a concurrency
 *     test whose participants all acquire locks via the same helper proves
 *     only the case that was already safe. A second connection takes
 *     `player_stats` BEFORE `locations` — the shipped travel bug's shape — and
 *     is expected to die of 40P01 against the real route.
 *  4. the seizure window. A known accidental interleaving, pinned rather than
 *     fixed: `seizeOnKill` (properties) takes no location and no player lock,
 *     so it can commit `owner = NULL` between `ownerAt`'s unlocked read and
 *     `payOwner`'s locked re-read. `payOwner` then returns 0n and both casino
 *     call sites discard it. The hand still settles, the money is conserved,
 *     and the seized owner is not credited — the wager degrades to the
 *     unowned-town sink. Documented at both call sites in
 *     `packages/plugins/casino/src/engine.ts`.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep. The one
 * `setTimeout` below is not a wait for state: it is a deliberate margin
 * between two deadlock-detector timers, explained where it appears.
 */

const { db, sql: conn } = testDb();

let app: FastifyInstance;
let closeServer: () => Promise<void>;

/** Every wager in this file. 100,000 * blackjack's 2.5 = 250,000 exposure. */
const WAGER = "100000";
const HOUSE_CASH = 10_000_000n;
const PLAYER_CASH = 1_000_000n;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    // Registration is rate-limited per IP and the app is booted once, so every
    // registration in this file shares one bucket unless the address differs.
    remoteAddress: `10.62.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username: `Croupier${regCounter}`, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ token: string; playerId: string }>();
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

/** `casino-play.test.ts`'s `seedHouse`: `cost` is the owner's lever, 0n = unset. */
async function seedHouse(locationId: string, ownerId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId, pluginId: "blackjack", ownerPlayerId: ownerId, cost: 0n, profit: 0n,
  });
  return id;
}

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats)
    .set({ locationId, cash, jailedUntil: null, hospitalUntil: null })
    .where(eq(playerStats.playerId, playerId));
}

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

/** Cash-kind ledger total for one player — the reduce-in-JS idiom
 *  `economy-invariant.test.ts` and `theft-lock-order.test.ts` both use. */
const ledgerCashOf = async (id: string): Promise<bigint> => {
  const rows = await db
    .select({ amount: transactions.amount, kind: transactions.balanceKind })
    .from(transactions)
    .where(eq(transactions.playerId, id));
  return rows.reduce((sum, r) => sum + (r.kind === "cash" ? r.amount : 0n), 0n);
};

const play = (token: string): InjectOptions => ({
  method: "POST",
  url: "/api/casino/play",
  headers: { authorization: `Bearer ${token}` },
  payload: { gameId: "blackjack", wager: WAGER },
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
 * Fires two plays released from one barrier that holds BOTH player rows in
 * ascending id order — the same order the shipped `tx.locks.player` call uses,
 * so the barrier is not itself an out-of-order actor. Each request parks on
 * its first lock, and releasing the barrier starts them from the same instant
 * with the interleaving already set up: the red is deterministic rather than a
 * coin flip per round (CLAUDE.md rule 6's corollary).
 */
async function raceTwoPlays(
  first: { token: string; id: string },
  second: { token: string; id: string },
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

    const a = fire(play(first.token));
    const b = fire(play(second.token));
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
  ({ app, close: closeServer } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("casino lock ordering", () => {
  it("does not deadlock when the house owner plays at their own table", async () => {
    // The owner playing their own table means one transaction would touch ONE
    // player row twice (as buyer and as house). The route collapses that to
    // `[player.id]`, and `tx.locks.player` dedupes and sorts anyway — this is
    // the case where the buyer and the owner are the same row, raced against a
    // stranger at the same table so the row is genuinely contended.
    const owner = await register();
    const stranger = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, owner.playerId);
    await placePlayer(owner.playerId, locationId, HOUSE_CASH);
    await placePlayer(stranger.playerId, locationId, PLAYER_CASH);

    const [ownerRes, strangerRes] = await raceTwoPlays(
      { token: owner.token, id: owner.playerId },
      { token: stranger.token, id: stranger.playerId },
    );

    // A deadlock is uncaught: 40P01 -> HTTP 500 on a well-formed request.
    expect(ownerRes.statusCode, `owner body: ${ownerRes.body}`).not.toBe(500);
    expect(strangerRes.statusCode, `stranger body: ${strangerRes.body}`).not.toBe(500);
    expect([ownerRes.statusCode, strangerRes.statusCode]).toEqual([200, 200]);

    // The owner's own wager moved out and straight back in (escrow debits the
    // player and credits the house, which is the same person) — so the only
    // net movement on the property is the stranger's hand.
    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(prop?.ownerPlayerId).toBe(owner.playerId);
  }, 30_000);

  it("survives A-plays-at-B's-table racing B-plays-at-A's-table", async () => {
    // THE ABBA PAIR, and the reason the single sorted `tx.locks.player` call is
    // load-bearing. Two towns, a blackjack house in each, cross-owned; each
    // player stands in the OTHER's town. Both lock sets are the same pair
    // {A, B}: under one sorted call both requests queue on the same first row
    // and cannot cycle. Split that call — lock the buyer, let `payOwner` lock
    // the owner second in its own statement — and A holds player_stats[A]
    // wanting player_stats[B] while B holds [B] wanting [A]: 40P01, uncaught,
    // HTTP 500 on a well-formed request. Shown red exactly that way; see the
    // task report for the verbatim Postgres log lines.
    const a = await register();
    const b = await register();
    const locA = await seedLocation();
    const locB = await seedLocation();
    await seedHouse(locA, a.playerId);
    await seedHouse(locB, b.playerId);
    // Each player stands in the other's town, and each is also the house for
    // the other's hand, so each needs to cover both the wager and the exposure.
    await placePlayer(a.playerId, locB, HOUSE_CASH);
    await placePlayer(b.playerId, locA, HOUSE_CASH);

    const [aRes, bRes] = await raceTwoPlays(
      { token: a.token, id: a.playerId },
      { token: b.token, id: b.playerId },
    );

    expect(aRes.statusCode, `A body: ${aRes.body}`).not.toBe(500);
    expect(bRes.statusCode, `B body: ${bRes.body}`).not.toBe(500);
    expect([aRes.statusCode, bRes.statusCode]).toEqual([200, 200]);
  }, 30_000);

  it("deadlocks when a caller takes the player lock before the location lock", async () => {
    const player = await register();
    const locationId = await seedLocation();
    // Unowned town: the route's lock set is exactly {locations[L],
    // player_stats[P]}, so this test measures the location↔player edge and
    // nothing else.
    await placePlayer(player.playerId, locationId, PLAYER_CASH);

    // Held in an object so the assertion below reads it after the helper has
    // thrown: the route outlives the inverted actor's abort, and what it
    // answered is the other half of the proof.
    const out: { route: Promise<LightMyRequestResponse> | null } = { route: null };

    /**
     * The inverted actor: `player_stats` FIRST, then `locations` — the exact
     * shape the shipped travel deadlock had, against the real `play` route.
     *
     * WHY THREE CONNECTIONS. Postgres kills whichever waiter's own
     * deadlock_timeout expires first, and `deadlock_timeout` is not settable
     * by this test's role. So the inverted actor must START WAITING BEFORE the
     * route does, or the route is the victim and the deadlock shows up as an
     * opaque HTTP 500 instead of a rejection here. `hold` takes locations[L]
     * first; the route queues behind it (holding nothing — locations is its
     * FIRST lock); the inverted actor takes player_stats[P] and queues behind
     * the route on locations[L]. Releasing `hold` hands locations[L] to the
     * route in queue order, and the route then wants player_stats[P]: the
     * cycle closes with the inverted actor having waited longest, so it is the
     * one that detects and aborts.
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

        const route = fire(play(player.token));
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
    if (out.route === null) throw new Error("the play request was never dispatched");
    const routeRes = await out.route;
    expect(routeRes.statusCode, `play body: ${routeRes.body}`).toBe(200);
  }, 60_000);

  it("settles, conserves money and credits nobody when the house is seized inside payOwner's window", async () => {
    // THE ACCIDENTAL INTERLEAVING, pinned rather than fixed. `seizeOnKill`
    // (packages/plugins/properties/src/seizure.ts) takes NO location lock and
    // NO player lock, and still UPDATEs the properties table on every kill, so
    // it is the one properties path the casino's `tx.locks.location` does not
    // exclude. The blocker below holds the property row and commits exactly
    // seizure's statement (`owner_player_id = NULL, cost = 0`) while the
    // casino's `payOwner` is parked on that row's FOR UPDATE — the same state
    // transition a kill would commit in that window, reached without booting
    // combat's weapon/hospital machinery.
    //
    // `payOwner`'s TOCTOU recheck then returns 0n and both casino call sites
    // discard it: the player is debited, nobody is credited, and the wager
    // degrades to the unowned-town sink the spec already defines.
    const player = await register();
    const owner = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, owner.playerId);
    await placePlayer(player.playerId, locationId, PLAYER_CASH);
    await placePlayer(owner.playerId, locationId, HOUSE_CASH);

    const playerCashBefore = await cashOf(player.playerId);
    const playerLedgerBefore = await ledgerCashOf(player.playerId);
    const ownerCashBefore = await cashOf(owner.playerId);
    const ownerLedgerBefore = await ledgerCashOf(owner.playerId);

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];
    let res: LightMyRequestResponse;

    try {
      await t0`BEGIN`;
      await t0`SELECT id FROM p_properties_properties WHERE id = ${propertyId}::uuid FOR UPDATE`;

      // Passes `ownerAt` (unlocked) and the exposure check, debits the player,
      // then parks inside `payOwner` on the property row's FOR UPDATE.
      const request = fire(play(player.token));
      inFlight.push(request);
      await waitForLockWaiters(1);

      // seizure.ts's UPDATE, verbatim in effect.
      await t0`
        UPDATE p_properties_properties SET owner_player_id = NULL, cost = 0
        WHERE owner_player_id = ${owner.playerId}::uuid
      `;
      await t0`COMMIT`;

      res = await request;
    } finally {
      try {
        await t0`ROLLBACK`;
      } catch {
        /* already committed */
      }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }

    // The hand still settles — the seizure is invisible to the player.
    expect(res.statusCode, `play body: ${res.body}`).toBe(200);
    const body = res.json<{ sessionId: string; done: boolean; payout?: string }>();

    // Same net-from-the-body idiom `casino-play.test.ts` uses: blackjack's
    // `start` can settle a natural off a real `node:crypto` shoe, and a payout
    // in that case rides back on top of the wager in the same call.
    const net = body.done ? BigInt(body.payout ?? "0") - BigInt(WAGER) : -BigInt(WAGER);
    expect(await cashOf(player.playerId)).toBe(playerCashBefore + net);

    // Nobody was credited: the seized owner's cash and the row's lifetime
    // `profit` are both untouched, and the row really is unowned.
    expect(await cashOf(owner.playerId)).toBe(ownerCashBefore);
    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(prop?.ownerPlayerId).toBeNull();
    expect(prop?.profit).toBe(0n);

    // Money is conserved (rule 3): every movement on either side is a ledger
    // row, so the balance delta equals the ledger delta for both players.
    expect(await ledgerCashOf(player.playerId)).toBe(playerLedgerBefore + net);
    expect(await ledgerCashOf(owner.playerId)).toBe(ownerLedgerBefore);

    // The session recorded the property it was opened against, seized or not.
    const [session] = await db.select().from(casinoSessions).where(eq(casinoSessions.id, body.sessionId));
    expect(session?.propertyId).toBe(propertyId);
  }, 60_000);

});
