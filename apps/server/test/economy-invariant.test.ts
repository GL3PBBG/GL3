import { and, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  crimes,
  items,
  locations,
  playerItems,
  players,
  playerStats,
  transactions,
} from "../src/db/schema/index.js";
import { seedCrimes, seedLocations, seedRanks } from "../src/db/seed.js";
import bankPlugin from "@gl3/plugin-bank";
import bulletsPlugin from "@gl3/plugin-bullets";
import combatPlugin from "@gl3/plugin-combat";
import inventoryPlugin from "@gl3/plugin-inventory";
import travelPlugin from "@gl3/plugin-travel";
import { PluginError } from "@gl3/plugin-sdk";
import { applyBalanceChange, InsufficientFundsError } from "../src/economy/ledger.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import crimesPlugin from "@gl3/plugin-crimes";
import detectivesPlugin from "@gl3/plugin-detectives";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const PLAYER_COUNT = 5;
const OP_COUNT = 1000;
const STARTING_CASH = 50_000n;

// This file calls runPluginJob/callPluginRoute/applyBalanceChange directly (no
// bootTestServer, no HTTP), so nothing namespaces their leaderboard writes
// automatically the way a booted test server would. The plugin job deps
// carry a run-unique `leaderboardPrefix` so this file never zadd's into
// the shared, global `leaderboard:*` keys other concurrent test
// files/agents may be reading.
const leaderboardPrefix = `invariant-test-${uuidv7()}`;
const pluginJobDeps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix });

let playerIds: string[] = [];
const usernameById = new Map<string, string>();
let crimeIds: string[] = [];
let locationIds: string[] = [];
let shopItemId: string;

beforeAll(async () => {
  await resetDb(db);
  await seedCrimes(db);
  await seedRanks(db);
  await seedLocations(db);
  // p_inventory_shop_stock and p_combat_log are plugin-owned tables (via
  // runPluginMigrations), not core migrations — this file drives plugin routes
  // directly with callPluginRoute rather than bootTestServer, so nothing else
  // here would apply those plugins' migrations first. combat and detectives
  // joined the list when core relinquished `combat_log` and
  // `detective_searches` in 0007_relinquish_plugin_tables: the sweep's `kill`
  // op writes a p_combat_log row on every fatal shot, and its `hire` op writes
  // a p_detectives_searches row.
  await runPluginMigrations(db, [inventoryPlugin, combatPlugin, detectivesPlugin]);

  // One item, stocked in every location, cheap and effectively unlimited so
  // the sweep's shopBuy op mostly succeeds rather than mostly 409ing.
  shopItemId = uuidv7();
  await db.execute(sql`
    insert into items (id, name, item_type, effects)
    values (${shopItemId}, 'Invariant Widget', 'consumable', ${JSON.stringify({ heal: 1 })}::jsonb)`);
  await db.execute(sql`
    insert into p_inventory_shop_stock (location_id, item_id, price, stock)
    select id, ${shopItemId}, 25::bigint, 100000 from locations`);

  crimeIds = (await db.select({ id: crimes.id }).from(crimes)).map((r) => r.id);
  locationIds = (await db.select({ id: locations.id }).from(locations)).map((r) => r.id);

  for (let i = 0; i < PLAYER_COUNT; i += 1) {
    const id = uuidv7();
    const username = `invariant${i}-${Date.now()}`;
    await db.insert(players).values({ id, username });
    usernameById.set(id, username);
    // Funded well above any single op's cost so most ops succeed and the
    // invariant is exercised under real balance movement, not mostly-rejects.
    await db.insert(playerStats).values({ playerId: id, cash: STARTING_CASH });
    playerIds.push(id);
  }

  // Combat's preconditions that are the same for every kill op: an equipped
  // weapon and enough exp to clear newbie protection. Neither is money, so
  // seeding them with raw statements leaves `sum(ledger) == balance`
  // untouched — the payout is the only part of combat that moves cash, and it
  // goes through `applyBalanceChange` like every other path here.
  const weaponId = uuidv7();
  await db.insert(items).values({
    id: weaponId,
    name: `invariant-weapon-${weaponId.slice(-8)}`,
    itemType: "weapon",
    // Accuracy 100 and a flat 100 damage against a full-health target: every
    // shot lands and every shot kills, so the payout runs on every kill op
    // rather than on whatever subset the dice allow. A sweep whose money path
    // fires one time in three is a weaker test for no gain in realism —
    // combat-resolve.test.ts is where the roll itself is exercised.
    // `backfireChance: 0` extends the same argument to the backfire roll: the
    // default `combat.backfire.base_chance` of 2 would fire the money path
    // 98 times in 100 instead of always, for no gain in realism.
    effects: { accuracy: 100, damageMin: 100, damageMax: 100, backfireChance: 0 },
  });
  await db.insert(playerItems).values(playerIds.map((id) => ({ playerId: id, itemId: weaponId, qty: 1 })));
  await db
    .update(playerStats)
    .set({ weaponItemId: weaponId, exp: 1000n })
    .where(inArray(playerStats.playerId, playerIds));
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

/**
 * NOT covered here: hospital's paid discharge (`hospital.discharge`), the one
 * other money path added by the PvP work. It is a CORE route, not a plugin
 * route, so `callPluginRoute` cannot drive it and this file boots no server to
 * `app.inject` against. Faking it with a direct `applyBalanceChange` would
 * prove only that the ledger works, which the `points` op already covers.
 * `sum(ledger) == balance` for that path is asserted directly in
 * `test/hospital.test.ts` ("discharges for cash, restores health, and ledgers
 * the payment"), which seeds its starting cash through the ledger for exactly
 * that reason.
 */
describe("economy invariant across every M2 money path", () => {
  // 1000 sequential in-process DB ops comfortably clears the default 5s
  // vitest timeout under load; the brief's own "well under a minute" budget
  // needs an explicit ceiling.
  it("keeps sum(ledger) == balance, per player, per kind, across 1000 randomized ops", async () => {
    const rand = mulberry32(20260807);
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

    // Op-type/outcome tallies purely for the assertion below and the task
    // report — not part of the invariant itself.
    const OP_NAMES = ["crime", "bank", "travel", "bullets", "points", "kill", "shopBuy", "detectiveHire"] as const;
    const attempted = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0, kill: 0, shopBuy: 0, detectiveHire: 0 };
    const succeeded = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0, kill: 0, shopBuy: 0, detectiveHire: 0 };

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
          await runPluginJob(
            pluginJobDeps(),
            crimesPlugin,
            "commit",
            { id: `invariant-crime-${i}`, data: { playerId, crimeId: pick(crimeIds), seed: `invariant-seed-${i}` } },
          );
        } else if (opName === "bank") {
          const direction = rand() < 0.5 ? "deposit" : "withdraw";
          const amount = BigInt(1 + Math.floor(rand() * 200));
          // bank is a plugin now; this drives its real route handler.
          await callPluginRoute(bankPlugin, "POST", `/api/bank/${direction}`, {
            db, redis, leaderboardPrefix, playerId, body: { amount: amount.toString() },
          });
        } else if (opName === "travel") {
          // travel is a plugin now; this drives its real route handler. Core's
          // performTravel had no cooldown gate — the route did — so clear the
          // key first, or nearly every op in this sweep would answer 429 and
          // travel coverage would silently collapse to almost nothing.
          // Targeted DEL, never FLUSHDB: Redis is shared with every other file.
          await redis.del(cooldownKey(playerId, "travel"));
          await callPluginRoute(travelPlugin, "POST", "/api/travel/:locationId", {
            db, redis, leaderboardPrefix, playerId, params: { locationId: pick(locationIds) },
          });
        } else if (opName === "bullets") {
          const quantity = 1 + Math.floor(rand() * 5);
          // bullets is a plugin now; this drives its real route handler, so
          // the 1000-op sum(ledger) == balance sweep still covers its actual
          // code path.
          await callPluginRoute(bulletsPlugin, "POST", "/api/bullets/buy", {
            db, redis, leaderboardPrefix, playerId, body: { quantity },
          });
        } else if (opName === "shopBuy") {
          // A purchase moves cash AND mutates p_inventory_shop_stock and
          // player_items in the same transaction — the shape most likely to
          // leave the ledger and the balance disagreeing if the money movement
          // is ever moved out of applyBalanceChange.
          const quantity = 1 + Math.floor(rand() * 3);
          await callPluginRoute(inventoryPlugin, "POST", "/api/shop/buy", {
            db, redis, leaderboardPrefix, playerId, body: { itemId: shopItemId, quantity },
          });
        } else if (opName === "kill") {
          // The kill payout is the first money movement in the game that is a
          // transfer between two players rather than a player and the house,
          // so it is the one path where a bug could balance the ATTACKER's
          // ledger while leaving the victim's short — the per-player assertion
          // below is what catches that.
          const victimId = pick(playerIds.filter((id) => id !== playerId));
          // Every precondition forced, all of them non-money columns: same
          // location, both out of hospital and jail, full health (100 damage
          // then kills outright), bullets in hand. All seven of the route's
          // legality rules are satisfied deterministically, which is why none
          // of combat's error codes joins the accept-list below — a
          // PluginError from here is a real failure, not an expected reject.
          await db
            .update(playerStats)
            .set({
              locationId: pick(locationIds),
              health: 100,
              bullets: 100n,
              hospitalUntil: null,
              jailedUntil: null,
            })
            .where(inArray(playerStats.playerId, [playerId, victimId]));
          // Targeted DEL of this attacker's own key, never FLUSHDB — Redis is
          // shared with every other file. The sweep is single-threaded, so
          // nothing can re-take the cooldown between here and the call.
          await redis.del(cooldownKey(playerId, "combat.attack"));
          await callPluginRoute(combatPlugin, "POST", "/api/combat/attack/:targetId", {
            db, redis, leaderboardPrefix, playerId,
            params: { targetId: victimId },
            // Pinned rather than left to the 100n default: if that default
            // ever rises above the seeded exp, every kill op would answer
            // `protected`, and this op's coverage would vanish behind a green
            // run. Written prefixed, as the `settings` table stores it: the
            // plugin asks for the bare `newbie_exp_threshold` and the SDK
            // prepends its own id.
            settings: { "combat.newbie_exp_threshold": "100" },
          });
        } else if (opName === "detectiveHire") {
          // Pure money sink to the house, same class as the travel fare. Cost
          // pinned low (settings written PREFIXED, as the settings table
          // stores them; the plugin asks for bare `cost`) so the sweep mostly
          // succeeds instead of mostly 409ing. The post-commit enqueue fails
          // by construction — deps.queues is an empty Map — and the route
          // logs-and-swallows that, which is exactly the "lost resolve" path
          // the list route reads as failed. The DEBIT is the invariant's
          // whole interest here; expect one logged enqueue error per op.
          const detTargetId = pick(playerIds.filter((id) => id !== playerId));
          await callPluginRoute(detectivesPlugin, "POST", "/api/detectives", {
            db, redis, leaderboardPrefix, playerId,
            body: {
              targetUsername: usernameById.get(detTargetId)!,
              detectives: 1 + Math.floor(rand() * 5),
              hours: 1 + Math.floor(rand() * 5),
            },
            settings: { "detectives.cost": "50" },
          });
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
        //
        // Deliberately NOT accepted, even though they are real PluginError codes
        // travel can throw: on_cooldown, location_changed, location_not_found.
        // All three are unreachable in THIS sweep by construction — the
        // redis.del immediately precedes each travel call and the sweep is
        // single-threaded (on_cooldown), a locationId mismatch needs a
        // concurrent move between the pre-read and the locked recheck that a
        // sequential sweep can never produce (location_changed), and location
        // ids come from the seeded table and are never deleted
        // (location_not_found). If any of the three ever fires here, that is
        // the bug — e.g. a future change namespacing the cooldown key by
        // plugin id would make cooldownKey(playerId, "travel") stop matching,
        // silently collapsing succeeded.travel to near-zero behind a wide
        // accept-list that swallowed the 429s as "expected". Keeping them out
        // is what lets the coverage assertion below actually catch that.
        if (
          err instanceof InsufficientFundsError ||
          // Every ported module's expected rejections arrive as the
          // PluginError its handler throws.
          (err instanceof PluginError &&
            (err.code === "insufficient_funds" || err.code === "insufficient_stock" ||
             err.code === "no_location" || err.code === "already_there"))
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
    // The accept-list above swallows bullets' three expected PluginError codes
    // alongside every other op kind's. A regression that made every bullets
    // call throw would satisfy the sweep-wide ratio above on the other four op
    // kinds alone and pass silently with zero bullets coverage — assert the
    // op kind directly, not just the aggregate.
    expect(succeeded.bullets).toBeGreaterThan(0);
    // The accept-list above swallows travel's expected rejections alongside
    // every other op kind's. A regression that made every travel fail would
    // still satisfy the other kinds and pass silently with zero travel
    // coverage — assert it moved at least once.
    expect(succeeded.travel).toBeGreaterThan(0);
    // Same reasoning as bullets/travel above: shopBuy's expected rejections
    // (no_location before a player's first travel op, insufficient_funds late
    // in the run) are in the accept-list too, so a regression that made every
    // purchase fail would otherwise pass silently on the aggregate ratio alone.
    expect(succeeded.shopBuy).toBeGreaterThan(0);
    // Same reasoning as bullets/travel/shopBuy: detectiveHire's expected
    // rejection (insufficient_funds late in the run) is in the accept-list,
    // so a regression that made every hire fail would otherwise pass silently
    // on the aggregate ratio alone.
    expect(succeeded.detectiveHire).toBeGreaterThan(0);
    // Kills throw nothing by construction (see the op above), so this only
    // guards the op being picked at all — a future OP_NAMES edit that drops
    // `kill` would otherwise leave the transfer path silently uncovered.
    expect(succeeded.kill).toBe(attempted.kill);
    expect(succeeded.kill).toBeGreaterThan(0);
    // A succeeded kill is not the same as money moving: a victim who is
    // already broke pays out 0, and combat skips both ledger writes at zero.
    // Without this, a run where every victim happened to be empty would count
    // 170 kills and exercise the transfer not once.
    const payouts = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(eq(transactions.reason, "combat.kill_payout"));
    expect(payouts.filter((p) => p.amount > 0n).length).toBeGreaterThan(0);

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
