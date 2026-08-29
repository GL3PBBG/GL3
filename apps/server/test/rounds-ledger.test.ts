import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  crimes, playerCrimeSkill, playerStats, roundEntries, rounds, settings as settingsTable, transactions,
} from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { ensureCurrentRound } from "../src/game/rounds/service.js";
import { payoutPoints } from "../src/game/rounds/settings.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { loadSettings } from "../src/settings/load.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { createOutboxDelivery } from "../src/bus/outbox.js";

const { db } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
// Deliberately different from `DEFAULT_PAYOUT_POINTS` ([1000n, 500n, 250n] in
// game/rounds/settings.ts) in every position, so the settings-load guard below
// can actually distinguish "the seeded row was read" from "seeding silently
// fell back to the default" — the two were indistinguishable when this table
// matched the default verbatim.
const AWARDS = [900n, 600n, 300n];
const SETTINGS_VALUE = "[900,600,300]";
// player_stats.cash defaults to `sql\`0\`` (src/db/schema/identity.ts) and
// /api/auth/register inserts playerStats with no cash override — read off
// the schema default, not guessed. Asserted directly against a freshly
// registered player below before it is relied on.
const STARTING_CASH = 0n;
// Fixed, small and well under Pickpocket's 50n minPayout so the deposit
// never rejects for insufficient funds regardless of the crime's random draw.
const DEPOSIT_AMOUNT = "10";

async function seedSetting(): Promise<void> {
  await db.insert(settingsTable)
    .values({ key: "rounds.payout_points", value: SETTINGS_VALUE })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: SETTINGS_VALUE } });
}

let app: Awaited<ReturnType<typeof bootTestServer>>["app"];
let closeServer: () => Promise<void>;

beforeAll(async () => {
  await resetDb(db);
  await seedSetting();                    // BEFORE the boot — settings load once
  const booted = await bootTestServer();
  app = booted.app;
  closeServer = booted.close;
  await subscriber.subscribe(GAME_EVENTS_CHANNEL);
});
afterAll(async () => { await closeServer(); subscriber.disconnect(); await redis.quit(); });
beforeEach(async () => { await resetDb(db); await seedSetting(); });

interface RegisteredPlayer { id: string; token: string; }

async function register(username: string): Promise<RegisteredPlayer> {
  const body = await registerVerifiedPlayer({ app, redis }, { username });
  return { id: body.playerId, token: body.token };
}

describe("the ledger reconciles across a rollover", () => {
  it("keeps sum(ledger) == balance per player per kind, through real money routes and a round payout", async () => {
    // --- settings sanity: the fixture's actual load, not a hoped-for value ---
    const loadedSettings = await loadSettings(db);
    expect(payoutPoints(loadedSettings)).toEqual(AWARDS);

    // --- three players, registered over HTTP ---
    const players = [
      await register(`ledger_a_${Date.now()}`),
      await register(`ledger_b_${Date.now()}`),
      await register(`ledger_c_${Date.now()}`),
    ];
    const playerIds = players.map((p) => p.id);

    for (const p of players) {
      const [stats] = await db.select({ cash: playerStats.cash }).from(playerStats)
        .where(eq(playerStats.playerId, p.id));
      expect(stats!.cash).toBe(STARTING_CASH);
    }

    // --- move money through two real routes: crime commit, then bank deposit ---
    await seedCrimes(db, "v2");
    const [pickpocket] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    if (!pickpocket) throw new Error("Pickpocket crime not seeded");

    // chance 100.00 makes the (job-id-seeded, otherwise uncontrollable) roll
    // succeed deterministically, so the crime path always credits cash rather
    // than exercising it only some fraction of the time.
    await db.insert(playerCrimeSkill).values(
      playerIds.map((playerId) => ({ playerId, crimeId: pickpocket.id, chance: "100.00" })),
    );

    for (const p of players) {
      // Set up the wait BEFORE firing the request: crime.resolved publishes
      // whether the roll wins or loses, so it is a reliable "the async commit
      // job has committed" signal even though success is forced above.
      const resolved = awaitOwnEvent(subscriber, p.id);
      const commit = await app.inject({
        method: "POST", url: `/api/crimes/${pickpocket.id}/commit`,
        headers: { authorization: `Bearer ${p.token}` },
      });
      expect(commit.statusCode).toBe(202);
      const event = await resolved;
      expect(event.type).toBe("crime.resolved");
      if (event.type !== "crime.resolved") throw new Error("unreachable");
      expect(event.success).toBe(true);

      const deposit = await app.inject({
        method: "POST", url: "/api/bank/deposit",
        headers: { authorization: `Bearer ${p.token}` },
        payload: { amount: DEPOSIT_AMOUNT },
      });
      expect(deposit.statusCode).toBe(200);
    }

    // --- seed an ended round with unambiguous placings, plus a successor ---
    const now = Date.now();
    const ago = (ms: number): Date => new Date(now - ms);
    const ahead = (ms: number): Date => new Date(now + ms);

    const endedRoundId = uuidv7();
    await db.insert(rounds).values({
      id: endedRoundId, name: "Ledger Round",
      startsAt: ago(7_200_000), endsAt: ago(3_600_000), snapshottedAt: ago(7_200_000),
    });
    const successorRoundId = uuidv7();
    await db.insert(rounds).values({
      id: successorRoundId, name: "Ledger Round Next",
      startsAt: ago(60_000), endsAt: ahead(3_600_000),
    });

    // Distinct, unambiguous exp deltas — direct player_stats writes, not the
    // ledger: exp is not a BalanceKind (only cash/bank/points are), so this
    // does not touch sum(ledger) == balance at all.
    const expByPlayer = [900n, 500n, 200n]; // -> awards AWARDS[0], AWARDS[1], AWARDS[2] in that order
    for (const [i, p] of players.entries()) {
      await db.update(playerStats).set({ exp: expByPlayer[i]! }).where(eq(playerStats.playerId, p.id));
      await db.insert(roundEntries).values({ roundId: endedRoundId, playerId: p.id, expAtStart: 0n });
    }
    const winnersInExpectedOrder = playerIds; // already highest-exp first

    // --- roll the round over, using the same settings record the server loaded ---
    const active = await ensureCurrentRound(db, createOutboxDelivery(db, { redis }), loadedSettings);
    expect(active?.id).toBe(successorRoundId);

    // --- the per-player, per-kind sweep (economy-invariant.test.ts:356-370) ---
    for (const playerId of playerIds) {
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      const kinds = { cash: stats!.cash, bank: stats!.bank, points: stats!.points } as const;
      for (const kind of ["cash", "bank", "points"] as const) {
        const ledgerRows = await db.select({ amount: transactions.amount })
          .from(transactions)
          .where(and(eq(transactions.playerId, playerId), eq(transactions.balanceKind, kind)));
        const ledgerSum = ledgerRows.reduce((sum, r) => sum + r.amount, 0n);
        const expected = kind === "cash" ? STARTING_CASH + ledgerSum : ledgerSum;
        expect(kinds[kind], `player ${playerId} kind ${kind}`).toBe(expected);
      }
    }

    // --- payout-specific assertions ---
    const payouts = await db.select().from(transactions)
      .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, endedRoundId)));

    expect(payouts).toHaveLength(3);
    expect(payouts.every((r) => r.balanceKind === "points")).toBe(true);
    expect(payouts.every((r) => r.refId === endedRoundId)).toBe(true);
    expect(payouts.every((r) => r.jobId === null)).toBe(true);

    // Placing order, not just the multiset: paying [300,600,900] sums the same.
    const paidInPlacingOrder = winnersInExpectedOrder.map((id) =>
      payouts.find((r) => r.playerId === id)!.amount);
    expect(paidInPlacingOrder).toEqual(AWARDS);
  }, 20_000);
});
