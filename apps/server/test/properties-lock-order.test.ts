import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The location↔player lock order, proven for `properties` against
 * counterparties that do NOT share its helper — the real travel route and the
 * real bullets purchase route.
 *
 * WHAT IS BEING PROVEN. The buy route takes `tx.locks.location(locationId)`
 * and only then `tx.locks.player([id])`
 * (`packages/plugins/properties/src/index.ts`). `bullets` and `travel` both go
 * locations-first, so a player-first buy closes an ABBA cycle with them: the
 * buy holds `player_stats[P]` wanting `locations[L]` while travel holds
 * `locations[L]` wanting `player_stats[P]` — 40P01, uncaught, and a
 * well-formed request answers 500.
 *
 * WHY A BARRIER, and not only a loop of concurrent rounds. CLAUDE.md's
 * corollary to rule 6 is that a concurrency test nobody has seen fail proves
 * nothing, and firing a buy and a travel together and hoping they interleave
 * is a coin flip per round. The first test below holds `locations[L]` on a
 * separate connection, queues a real travel behind it, then queues a real buy
 * BY THE SAME PLAYER behind that, and releases them from one instant with the
 * interleaving fixed. Under the shipped order the buy waits holding nothing,
 * then loses the race for real (travel already moved the player away by the
 * time it wakes) and correctly answers `wrong_location`; under a player-first
 * inversion it deadlocks against the travel instead and answers 500. Same
 * player on both requests is what makes this an ABBA candidate at all — see
 * the in-test comment for why.
 *
 * The blocker is not itself an out-of-order actor: it takes exactly one lock,
 * `locations[L]`, which is the FIRST lock in the canonical order. A
 * transaction holding one lock cannot be half of a cycle.
 *
 * Waits are on observed lock state in pg_stat_activity, never a sleep.
 *
 * BUY'S SHAPE (Task 7). Buy is no longer `/api/properties/:id/buy` — it is
 * `POST /api/properties/buy` with `{pluginId, locationId}` in the body, and
 * the row is created lazily on first purchase rather than pre-seeded. Every
 * buy below targets `pluginId: "bullets"` (the Bullet Factory franchise,
 * bullets' `providesProperties` declaration, $1,000,000 — money bigints are
 * whole dollars, V2's unit, copied verbatim by the migrator)
 * — the only property type any core plugin declares. `sell` and `claim` are
 * gone (Task 5 dropped the accrual clock they served); the load test below
 * no longer drives them.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

/** Enough concurrent actors that the two location rows are genuinely contended. */
const PLAYERS = 8;
const ROUNDS = 20;

/** Bullets' declared property price — packages/plugins/bullets/src/index.ts. */
const PROPERTY_PRICE = 1_000_000n;
const STARTING_CASH = 5n * PROPERTY_PRICE;

let app: FastifyInstance;
let closeServer: () => Promise<void>;
/** L is generated FIRST, so `L < C` as uuidv7s — travel locks both rows in
 * ascending id order, which makes L the row it blocks on. */
let lId: string;
let cId: string;
let tokens: string[] = [];
let playerIds: string[] = [];
let barrierToken: string;
let barrierId: string;

/** Every successful buy and every tolerated `buy`-route refusal seen in this
 *  file. Scoped to `buy` specifically, not every label: `travel`'s own
 *  `on_cooldown`/`already_there` refusals are guaranteed by its cooldown and
 *  by same-destination requests regardless of whether `buy`'s ownership
 *  check does anything at all, so counting every label's 4xx would make the
 *  assertion below pass even with that check deleted. */
let successfulBuys = 0;
let buyRefusals = 0;

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
  label: "buy" | "travel" | "bullets";
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
  if (label === "buy" && res.statusCode === 200) successfulBuys += 1;
  if (label === "buy" && res.statusCode >= 400) buyRefusals += 1;
  return { label, status: res.statusCode, error, body: res.body };
}

/**
 * The refusals a contended run is allowed to produce, enumerated per route.
 * Anything else — including a 500 from an uncaught 40P01 — fails the round it
 * happened in, naming the body.
 *
 *   buy       already_owned        another player won this property first
 *             insufficient_funds   cash ran out mid-run
 *             wrong_location       this player's OWN travel (below) landed
 *                                  first and moved them off the location the
 *                                  buy targeted — the same legitimate race
 *                                  the barrier test above proves is not a
 *                                  deadlock
 *   travel    on_cooldown          the 1s per-location travel cooldown
 *             already_there        destination == current, decided pre-lock
 *             location_changed     three retries lost to the caller's own moves
 *   bullets   insufficient_stock   stock ran out at this location
 *             insufficient_funds   cash ran out
 *             no_location          the location row has no bullet shop
 */
const ALLOWED_ERRORS: Record<Observed["label"], readonly string[]> = {
  buy: ["already_owned", "insufficient_funds", "wrong_location"],
  travel: ["on_cooldown", "already_there", "location_changed"],
  bullets: ["insufficient_stock", "insufficient_funds", "no_location"],
};

/** Success is narrow too: every route answers exactly one 2xx. */
const ALLOWED_OK: Record<Observed["label"], readonly number[]> = {
  buy: [200],
  travel: [200],
  bullets: [200],
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

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  // Registration is rate-limited per IP and the app is booted once, so every
  // registration in this file shares one bucket unless the address differs.
  return registerVerifiedPlayer({ app, redis }, {
    username: `Landlord${regCounter}`,
    remoteAddress: `10.55.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

/** Finds the (possibly not-yet-created) bullets-franchise property row at `locId`. */
async function propertyIdAt(locId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: propertiesPlugin.id })
    .from(propertiesPlugin)
    .where(and(eq(propertiesPlugin.locationId, locId), eq(propertiesPlugin.pluginId, "bullets")));
  return row?.id;
}

beforeAll(async () => {
  await resetDb(db);
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
    // bulletCost 1 keeps the bullets route genuinely contending for cash.
    { id: lId, name: "Lockfield", travelCost: 0n, travelCooldownSeconds: 1, bulletStock: 1_000_000, bulletCost: 1n },
    { id: cId, name: "Cashburg", travelCost: 0n, travelCooldownSeconds: 1, bulletStock: 1_000_000, bulletCost: 1n },
  ]);

  // No property rows pre-seeded — buy creates one lazily on first purchase,
  // at whichever of L/C a request names.

  tokens = [];
  playerIds = [];
  for (let i = 0; i < PLAYERS; i += 1) {
    const { token, playerId } = await register();
    tokens.push(token);
    playerIds.push(playerId);
  }
  ({ token: barrierToken, playerId: barrierId } = await register());
  successfulBuys = 0;
  buyRefusals = 0;

  // Five times the property price comfortably covers one purchase plus
  // ROUNDS rounds of 1-cent bullet buys, per player.
  await db
    .update(playerStats)
    .set({ locationId: lId, cash: STARTING_CASH, jailedUntil: null, hospitalUntil: null })
    .where(inArray(playerStats.playerId, [...playerIds, barrierId]));
});

afterAll(async () => {
  // Targeted deletes of this file's own keys — never FLUSHDB. Every id is a
  // fresh uuidv7, so nothing else in the suite owns them.
  for (const id of [...playerIds, barrierId]) {
    await redis.del(cooldownKey(id, "travel"));
  }
  await closeServer?.();
  await conn.end();
  redis.disconnect();
});

describe("properties lock ordering", () => {
  it("queues the buy safely behind a travel racing the same player, with no deadlock", async () => {
    await redis.del(cooldownKey(barrierId, "travel"));
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

      // The real buy of the bullets franchise at L, by the SAME player,
      // queued BEHIND the travel on the same row. Reusing the same player
      // for both is what makes this an ABBA candidate at all: a buy and a
      // travel for two DIFFERENT players never contend for the same
      // player_stats row, so a player-first buy couldn't deadlock against
      // them regardless of order — the shared player row is the second edge
      // of the cycle.
      //
      // Under the SHIPPED order this request holds nothing while it waits.
      // Under a player-first inversion it would already hold
      // player_stats[barrierId] while travel — queued ahead of it for
      // locations[L] — holds locations[L] wanting that same row next: the
      // cycle, and a 40P01.
      const buy = fire({
        method: "POST",
        url: "/api/properties/buy",
        headers: auth(barrierToken),
        payload: { pluginId: "bullets", locationId: lId },
      });
      inFlight.push(buy);
      await waitForLockWaiters(2);

      // Releases both from the same instant, with the interleaving fixed.
      await t0`ROLLBACK`;

      const [travelRes, buyRes] = await Promise.all([travel, buy]);

      // A deadlock is uncaught: 40P01 -> HTTP 500 on a well-formed request.
      // That absence is the whole proof — what each request answers with
      // otherwise is ordinary business logic, not a lock-order property.
      expect(travelRes.statusCode, `travel body: ${travelRes.body}`).not.toBe(500);
      expect(buyRes.statusCode, `buy body: ${buyRes.body}`).not.toBe(500);

      expect(travelRes.statusCode, `travel body: ${travelRes.body}`).toBe(200);

      // Travel was queued FIRST for locations[L] (rule 6: it locks source and
      // destination together, taking both before touching player_stats), so
      // it wins the row and commits first, moving the player to C. The buy
      // holds nothing while parked — that is the shipped order — so by the
      // time it finally gets locations[L] and re-reads player_stats under
      // its own lock, the player has genuinely left. `wrong_location` is
      // correct, not a symptom: the lock-then-recheck TOCTOU guard is what
      // stops the buy from acting on the stale "still at L" it read before
      // ever taking a lock.
      expect(buyRes.statusCode, `buy body: ${buyRes.body}`).toBe(409);
      expect(JSON.parse(buyRes.body)).toMatchObject({ error: "wrong_location" });

      // No side effect: the buy's PluginError aborts its transaction before
      // any write to propertiesTable, so no row exists at L.
      expect(await propertyIdAt(lId)).toBeUndefined();

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

  it("does not deadlock when two players transfer to each other concurrently, repeatedly", async () => {
    // Regression for a real bug caught in review, not a hypothetical: the
    // shipped `transferRoute` once took the caller's own row through
    // `loadOwnedRow`'s `tx.locks.player` call, then took a SECOND, separate
    // `tx.locks.player([caller, target])` call after resolving the target.
    // `tx.locks.player` sorts and dedupes WITHIN a call but remembers
    // nothing ACROSS calls in the same transaction, so two players
    // transferring to each other at the same moment each already held their
    // OWN row from call 1 and then blocked on the OTHER's row in call 2 — a
    // genuine ABBA cycle, a real 40P01, an uncaught 500. Fixed by folding the
    // target into `loadOwnedRow`'s ONE `tx.locks.player` call via its
    // `alsoLock` parameter (`packages/plugins/properties/src/index.ts`).
    //
    // Not a barrier this time: a barrier can only sequence what happens
    // BETWEEN two separate HTTP requests, and this bug lived entirely
    // INSIDE one transaction's two lock statements, which nothing outside
    // the process can pause between. Instead this fires many concurrent
    // A<->B transfer pairs back to back: ownership swaps every round, so
    // the SAME two player rows are genuinely fought over, in opposite
    // directions, every single round — only the exact timing of the race is
    // left to chance. Proven to actually reproduce the bug: see the fix
    // report for a run against the pre-fix two-call shape landing a real
    // 40P01/500, not an assertion mismatch.
    const pa = await register();
    const pb = await register();

    const locA = uuidv7();
    const locB = uuidv7();
    await db.insert(locations).values([
      { id: locA, name: "Twinbridge-A", travelCost: 0n, travelCooldownSeconds: 1, bulletStock: 0, bulletCost: 1n },
      { id: locB, name: "Twinbridge-B", travelCost: 0n, travelCooldownSeconds: 1, bulletStock: 0, bulletCost: 1n },
    ]);
    await db
      .update(playerStats)
      .set({ cash: STARTING_CASH })
      .where(inArray(playerStats.playerId, [pa.playerId, pb.playerId]));

    // Two DIFFERENT locations, one property each — this isolates the test to
    // the player-lock cycle only; the two transfers below never contend for
    // the same locations[] row, so any deadlock caught here can only be the
    // player-pair one.
    await db.update(playerStats).set({ locationId: locA }).where(eq(playerStats.playerId, pa.playerId));
    const buyA = await fire({
      method: "POST", url: "/api/properties/buy", headers: auth(pa.token),
      payload: { pluginId: "bullets", locationId: locA },
    });
    expect(buyA.statusCode, `buyA body: ${buyA.body}`).toBe(200);
    const propA = buyA.json<{ propertyId: string }>().propertyId;

    await db.update(playerStats).set({ locationId: locB }).where(eq(playerStats.playerId, pb.playerId));
    const buyB = await fire({
      method: "POST", url: "/api/properties/buy", headers: auth(pb.token),
      payload: { pluginId: "bullets", locationId: locB },
    });
    expect(buyB.statusCode, `buyB body: ${buyB.body}`).toBe(200);
    const propB = buyB.json<{ propertyId: string }>().propertyId;

    const TRANSFER_ROUNDS = 40;
    // Tracks current ownership so every round's callers genuinely own what
    // they're transferring — no DB read needed, the swap is deterministic.
    let paOwnsA = true;
    let pbOwnsB = true;

    for (let round = 0; round < TRANSFER_ROUNDS; round += 1) {
      const callerOfA = paOwnsA ? pa : pb;
      const targetOfA = paOwnsA ? pb : pa;
      const callerOfB = pbOwnsB ? pb : pa;
      const targetOfB = pbOwnsB ? pa : pb;

      const [resA, resB] = await Promise.all([
        fire({
          method: "POST", url: `/api/properties/${propA}/transfer`, headers: auth(callerOfA.token),
          payload: { username: targetOfA.username },
        }),
        fire({
          method: "POST", url: `/api/properties/${propB}/transfer`, headers: auth(callerOfB.token),
          payload: { username: targetOfB.username },
        }),
      ]);

      const where = `round ${round}`;
      expect(resA.statusCode, `${where} transfer A body: ${resA.body}`).not.toBe(500);
      expect(resB.statusCode, `${where} transfer B body: ${resB.body}`).not.toBe(500);
      // Every round's callers legitimately own what they're transferring, so
      // under correct behaviour both always succeed — a genuine correctness
      // check, not just "didn't crash".
      expect(resA.statusCode, `${where} transfer A body: ${resA.body}`).toBe(204);
      expect(resB.statusCode, `${where} transfer B body: ${resB.body}`).toBe(204);

      paOwnsA = !paOwnsA;
      pbOwnsB = !pbOwnsB;
    }
  }, 60_000);

  it("survives repeated buys, purchases and travels contending for the same rows", async () => {
    // NOT the regression proof — without the barrier the interleaving is luck.
    // This covers the shipped handlers coexisting under real load, each
    // taking its locks through its OWN code path: properties' tx.locks.location
    // + tx.locks.player, bullets' tx.locks.location + applyBalanceChange,
    // travel's tx.locks.locations + tx.locks.player. No shared driver.
    const observations: Observed[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      // The 1s cooldown exists so a player CAN act every round; clearing it is
      // what makes every round actually contended rather than mostly 429.
      for (const id of playerIds) {
        await redis.del(cooldownKey(id, "travel"));
      }

      // Read where everyone is, so every travel below is a real move rather
      // than a pre-lock `already_there`, and every buy targets wherever the
      // player currently stands — the request whose lock order is under test,
      // aimed at the row the travels of the SAME player contend for.
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
        const at = where.get(id);
        const destination = at === lId ? cId : lId;
        const buy = (): Promise<Observed> =>
          observe("buy", fire({
            method: "POST",
            url: "/api/properties/buy",
            headers: auth(token),
            payload: { pluginId: "bullets", locationId: at },
          }));
        const travel = (): Promise<Observed> =>
          observe("travel", fire({ method: "POST", url: `/api/travel/${destination}`, headers: auth(token) }));
        const bullets = (): Promise<Observed> =>
          observe("bullets", fire({
            method: "POST",
            url: "/api/bullets/buy",
            headers: auth(token),
            payload: { quantity: 1 },
          }));

        if (i < 6) {
          // A buy racing its OWN travel on the same location row: the natural
          // producer of the ABBA window, whichever way the two land.
          pending.push(buy(), travel());
        } else {
          pending.push(bullets(), travel());
        }
      }

      for (const o of await Promise.all(pending)) {
        observations.push(o);
        assertTolerated(round, o);
      }
    }

    // The run did real work, not hundreds of refusals: properties actually
    // changed hands, and money actually moved to the bullets route.
    const travelled = observations.filter((o) => o.label === "travel" && o.status === 200).length;
    const bought = observations.filter((o) => o.label === "buy" && o.status === 200).length;
    expect(bought, `only ${bought} buys succeeded`).toBeGreaterThan(0);
    expect(travelled, `only ${travelled} travels succeeded`).toBeGreaterThan(ROUNDS);

    // Whatever the interleaving, the ledger still balances (rule 3). Cash
    // movements here: property buy −100,000,000 (once per location, since
    // nothing in this load drops or transfers it back), bullets
    // −quantity×price. Travel is free by seed (travelCost 0).
    for (const id of playerIds) {
      const ledger = await db.select().from(transactions).where(eq(transactions.playerId, id));
      const sum = ledger.reduce((acc, r) => acc + (r.balanceKind === "cash" ? r.amount : 0n), 0n);
      const [stats] = await db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, id));
      expect(stats?.cash).toBe(STARTING_CASH + sum);
    }
  }, 120_000);

  it("observed at least one successful buy and one buy refusal", async () => {
    // The load above is real, not a stream of no-ops on the buy route
    // specifically: something bought successfully and something was refused
    // by `buy` itself (already_owned / insufficient_funds / wrong_location).
    // Scoped to `buy`'s own refusals, not every route's — see the comment on
    // `buyRefusals` above for why an unscoped counter would pass vacuously.
    expect(successfulBuys, `successful buys this run: ${successfulBuys}`).toBeGreaterThanOrEqual(1);
    expect(buyRefusals, `buy refusals this run: ${buyRefusals}`).toBeGreaterThanOrEqual(1);
  });
});
